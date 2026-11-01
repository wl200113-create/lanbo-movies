// Lanbo 影视基地 - 数据更新脚本
// 用法: node scripts/fetch.mjs
// 定时: Windows 任务计划 / GitHub Actions，每天 8:00 13:00 18:00 运行
// 逻辑: 从公开豆瓣数据接口抓取热映+热门剧集，过滤评分 >= 7.3，写入 data/movies.json
//       抓取失败时保留旧数据，只更新时间戳中的 lastAttempt

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'movies.json');
const MIN_RATING = 7.3;
const MIN_RATING_COUNT = 5000; // 评分人数下限，过滤冷门片

// 非官方豆瓣数据接口（随时可能失效，脚本已做容错兜底）
// unit: now=正在热映/热播；classic=馆藏经典/佳片
const SOURCES = [
  { name: '正在热映', key: 'movie_showing', unit: 'now', type: 'movie', count: 30 },
  { name: '即将上映', key: 'movie_soon', unit: 'now', type: 'movie', count: 20 },
  { name: '豆瓣电影 Top250', key: 'movie_top250', unit: 'classic', type: 'movie', count: 50 },
  { name: '一周口碑榜', key: 'movie_weekly_best', unit: 'classic', type: 'movie', count: 20 },
  { name: '热门剧集', key: 'tv_hot', unit: 'now', type: 'tv', count: 40 },
  { name: '国产剧', key: 'tv_domestic', unit: 'now', type: 'tv', count: 40 },
  { name: '美剧', key: 'tv_american', unit: 'now', type: 'tv', count: 30 },
  { name: '日剧', key: 'tv_japanese', unit: 'classic', type: 'tv', count: 30 },
  { name: '韩剧', key: 'tv_korean', unit: 'classic', type: 'tv', count: 30 },
  { name: '纪录片', key: 'tv_documentary', unit: 'classic', type: 'tv', count: 25 },
  { name: '综艺', key: 'tv_variety_show', unit: 'now', type: 'tv', count: 25 },
  { name: '动画', key: 'tv_animation', unit: 'classic', type: 'tv', count: 25 },
].map(s => ({
  ...s,
  url: `https://m.douban.com/rexxar/api/v2/subject_collection/${s.key}/items?start=0&count=${s.count}`,
}));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Referer': 'https://m.douban.com/',
};

// 豆瓣热门接口不直接给结构化主创/地区字段，但 card_subtitle 形如:
// 电影: "2026 / 中国大陆 / 剧情 战争 / 文牧野 / 沈腾 蒋奇明"
// 从中解析 年份/地区/类型/导演/主演
function parseSubtitle(sub) {
  const out = { year: null, region: '', genres: [], directors: [], casts: [] };
  if (!sub || !sub.includes('/')) return out;
  const parts = sub.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return out;
  if (/^\d{4}$/.test(parts[0])) out.year = parseInt(parts.shift(), 10);
  // 地区段：可能含多个国家（空格分隔），排除已知类型词
  const GENRE_WORDS = /剧情|喜剧|动作|爱情|科幻|悬疑|惊悚|恐怖|犯罪|战争|历史|奇幻|冒险|灾难|动画|纪录片|古装|武侠|家庭|传记|音乐|歌舞|运动|西部|同性|儿童|真人秀|脱口秀|短片|舞台|戏曲/;
  if (parts.length && !GENRE_WORDS.test(parts[0])) {
    out.region = parts.shift();
  }
  if (parts.length && GENRE_WORDS.test(parts[0])) {
    out.genres = parts.shift().split(/\s+/).filter(Boolean);
  }
  if (parts.length) out.directors = parts.shift().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length) out.casts = parts.join(' ').split(/\s+/).filter(Boolean).slice(0, 5);
  return out;
}

function regionGroupOf(region) {
  if (/中国|香港|台湾/.test(region)) return '华语';
  if (/日本|韩国/.test(region)) return '日韩';
  if (/美国|英国|法国|德国|意大利|加拿大|澳大利亚|西班牙|丹麦|瑞典|挪威|荷兰|比利时/.test(region)) return '欧美';
  return '其他';
}

function names(list) {
  // 兼容 [{name:...}] / [null] / ["张三"] 各种返回形态
  return (list || []).map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
}

// 角标分级：只给"正在热映/热播"单元打角标（经典单元本身已是 Top250，再打标就是噪音）
// 🏆 神作(>=9.0) > ⭐ 高分佳作(>=8.5) > 📺 热播剧集 > 📈 黑马飙升(评分人数<3万)
function badgeOf({ rating, ratingCount, year, type, sourceKey, unit }) {
  if (unit !== 'now') return '';
  if (rating >= 9.0) return '🏆 神作';
  if (rating >= 8.5) return '⭐ 高分佳作';
  if (type === 'tv') return '📺 热播剧集';
  if (ratingCount < 30000) return '📈 黑马飙升';
  return '';
}

function mapItem(item, type, sourceKey, unit) {
  const rating = item.rating?.value ?? 0;
  const ratingCount = item.rating?.count ?? 0;
  const sub = parseSubtitle(item.card_subtitle || '');
  // 剧集接口常直接给简介长文本（没有年份/地区结构），此时 subtitle 就是简介本身
  const subIsSummary = (item.card_subtitle || '') && !/^\d{4}\s*\//.test(item.card_subtitle.trim());
  const region = (item.countries || []).join('/') || sub.region;
  const year = parseInt(item.year, 10) || sub.year;
  return {
    id: item.id ? `db${item.id}` : `tmp_${item.title}`,
    doubanId: item.id || '',
    title: item.title || '',
    originalTitle: item.original_title || '',
    type,
    genres: (item.genres && item.genres.length) ? item.genres : sub.genres,
    year,
    region,
    regionGroup: regionGroupOf(region),
    language: '',
    rating,
    ratingCount,
    directors: names(item.directors).length ? names(item.directors) : sub.directors,
    casts: names(item.actors).length ? names(item.actors).slice(0, 5) : sub.casts,
    duration: item.durations?.[0] || '',
    episodes: item.episodes_count ? `${item.episodes_count}集` : '',
    status: '',
    poster: item.pic?.normal || item.cover?.url || '',
    summary: item.comment || (subIsSummary ? item.card_subtitle : '') || '',
    highlights: '', // AI 看点由本地补充，抓取数据不含
    audience: '',
    tag: badgeOf({ rating, ratingCount, year, type, sourceKey, unit }),
    listTag: unit === 'now' ? 'hot' : 'classic',
    curatorNote: '',
    series: '',
    wantCount: 0,
    oneLine: '',
    platforms: [],
  };
}

function isQualified(m) {
  return m.rating >= MIN_RATING && m.ratingCount >= MIN_RATING_COUNT && m.title;
}

async function fetchSource(src) {
  const res = await fetch(src.url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${src.name} HTTP ${res.status}`);
  const json = await res.json();
  const items = json.subject_collection_items || [];
  return items.map(i => mapItem(i, src.type, src.key, src.unit)).filter(isQualified);
}

// 豆瓣图床有防盗链：不带豆瓣 Referer 会返回 418 + 占位图，浏览器无法伪造 Referer，
// 所以抓取时把海报下载到 assets/posters/，网站直接用本地文件。
const POSTER_DIR = join(__dirname, '..', 'assets', 'posters');
const POSTER_HEADERS = {
  'User-Agent': HEADERS['User-Agent'],
  'Referer': 'https://movie.douban.com/',
};

async function downloadPoster(m) {
  if (!m.doubanId) return;
  const file = join(POSTER_DIR, `${m.doubanId}.jpg`);
  const rel = `assets/posters/${m.doubanId}.jpg`;
  // 已下载过就不重复拉取
  try {
    const st = statSync(file);
    if (st.size > 1024) { m.poster = rel; return; }
  } catch { /* 尚未下载 */ }
  if (!m.poster || !/^https?:/.test(m.poster)) return;
  try {
    const res = await fetch(m.poster, { headers: POSTER_HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // 防盗链占位图只有十几字节，过滤掉
    if (buf.byteLength < 1024) throw new Error('返回占位图，可能被防盗链拦截');
    writeFileSync(file, buf);
    m.poster = rel;
    console.log(`  🖼  海报已保存: ${m.title}`);
  } catch (e) {
    console.warn(`  ⚠️ 海报下载失败(${m.title}): ${e.message}`);
    m.poster = '';
  }
}

async function main() {
  const now = new Date().toISOString();
  let old = { movies: [] };
  try {
    old = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch { /* 首次运行没有旧文件 */ }

  // 确保海报目录存在
  mkdirSync(POSTER_DIR, { recursive: true });

  const results = [];
  const errors = [];
  for (const src of SOURCES) {
    try {
      const items = await fetchSource(src);
      console.log(`✅ ${src.name}: 抓到 ${items.length} 部 >= ${MIN_RATING} 分`);
      results.push(...items);
    } catch (e) {
      console.warn(`⚠️ ${src.name} 抓取失败: ${e.message}`);
      errors.push(e.message);
    }
  }

  if (results.length === 0) {
    // 全部失败：保留旧数据，只记录尝试时间
    old.lastAttempt = now;
    old.lastError = errors.join('; ');
    writeFileSync(DATA_FILE, JSON.stringify(old, null, 2), 'utf8');
    console.log('❌ 所有数据源失败，保留旧数据');
    process.exit(0);
  }

  // 去重（按豆瓣 id）：保留评分人数更多的条目，但只要有任一榜单属于"正在热映/热播"就归入 hot
  const hotIds = new Set(results.filter(m => m.listTag === 'hot').map(m => m.id));
  const seen = new Map();
  for (const m of results) {
    const cur = seen.get(m.id);
    if (!cur || cur.ratingCount < m.ratingCount) seen.set(m.id, m);
  }
  for (const m of seen.values()) {
    m.listTag = hotIds.has(m.id) ? 'hot' : 'classic';
  }
  // 与旧数据合并：保留旧条目里的人工策展字段
  const oldMap = new Map(old.movies.map(m => [m.id, m]));
  for (const m of seen.values()) {
    const o = oldMap.get(m.id);
    if (o) {
      for (const f of ['highlights', 'audience', 'curatorNote', 'series', 'oneLine']) {
        m[f] = m[f] || o[f] || '';
      }
      m.wantCount = m.wantCount || o.wantCount || 0;
      m.platforms = m.platforms?.length ? m.platforms : (o.platforms || []);
    }
  }

  // 下载海报到本地（并发 6，避免打太快）
  const list = [...seen.values()];
  console.log(`🖼  开始下载 ${list.length} 张海报…`);
  let cursor = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < list.length) {
      await downloadPoster(list[cursor++]);
    }
  }));

  const movies = list.sort((a, b) => b.rating - a.rating);
  const out = {
    updatedAt: now,
    source: 'douban-mirror',
    minRating: MIN_RATING,
    curator: old.curator || { name: 'Lanbo', title: '馆长 · 策展人', motto: '只收藏值得花两小时的好片子。' },
    hotKeywords: old.hotKeywords || [],
    movies,
  };
  writeFileSync(DATA_FILE, JSON.stringify(out, null, 2), 'utf8');
  const okCount = movies.filter(m => m.poster).length;
  console.log(`🎬 已写入 ${movies.length} 部影片（海报 ${okCount}/${movies.length}）-> data/movies.json`);
}

main().catch(e => {
  console.error('脚本异常:', e);
  process.exit(1);
});
