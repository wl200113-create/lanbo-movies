// Lanbo 影视基地 - 数据更新脚本
// 用法: node scripts/fetch.mjs
// 定时: Windows 任务计划 / GitHub Actions，每天 8:00 13:00 18:00 运行
// 逻辑: 从公开豆瓣数据接口抓取热映+热门剧集，过滤评分 >= 7.3，写入 data/movies.json
//       抓取失败时保留旧数据，只更新时间戳中的 lastAttempt

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'movies.json');
const MIN_RATING = 7.3;
const MIN_RATING_COUNT = 5000; // 评分人数下限，过滤冷门片

// 非官方豆瓣数据接口（随时可能失效，脚本已做容错兜底）
const SOURCES = [
  {
    name: '热映电影',
    key: 'movie_showing',
    url: 'https://m.douban.com/rexxar/api/v2/subject_collection/movie_showing/items?start=0&count=30',
    type: 'movie',
  },
  {
    name: '热门剧集',
    key: 'tv_hot',
    url: 'https://m.douban.com/rexxar/api/v2/subject_collection/tv_hot/items?start=0&count=30',
    type: 'tv',
  },
  {
    name: '热门国产剧',
    key: 'tv_domestic',
    url: 'https://m.douban.com/rexxar/api/v2/subject_collection/tv_domestic/items?start=0&count=20',
    type: 'tv',
  },
];

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

// 角标分级：每部片最多一个，按优先级取（空字符串 = 不显示角标）
// 🏆 神作(>=9.0) > ⭐ 高分佳作(>=8.5) > 🔥 院线热映(近两年) > 📺 热播剧集 > 📈 黑马飙升(评分人数<3万)
function badgeOf({ rating, ratingCount, year, type, sourceKey }) {
  const thisYear = new Date().getFullYear();
  if (rating >= 9.0) return '🏆 神作';
  if (rating >= 8.5) return '⭐ 高分佳作';
  if (sourceKey === 'movie_showing' && year && year >= thisYear - 1) return '🔥 院线热映';
  if (type === 'tv') return '📺 热播剧集';
  if (ratingCount < 30000) return '📈 黑马飙升';
  return '';
}

function mapItem(item, type, sourceKey) {
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
    tag: badgeOf({ rating, ratingCount, year, type, sourceKey }),
    listTag: sourceKey === 'movie_showing' || sourceKey === 'tv_hot' ? 'hot' : 'classic',
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
  return items.map(i => mapItem(i, src.type, src.key)).filter(isQualified);
}

async function main() {
  const now = new Date().toISOString();
  let old = { movies: [] };
  try {
    old = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch { /* 首次运行没有旧文件 */ }

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

  // 去重（按豆瓣 id）
  const seen = new Map();
  for (const m of results) {
    if (!seen.has(m.id) || (seen.get(m.id).ratingCount < m.ratingCount)) seen.set(m.id, m);
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

  const movies = [...seen.values()].sort((a, b) => b.rating - a.rating);
  const out = {
    updatedAt: now,
    source: 'douban-mirror',
    minRating: MIN_RATING,
    curator: old.curator || { name: 'Lanbo', title: '馆长 · 策展人', motto: '只收藏值得花两小时的好片子。' },
    hotKeywords: old.hotKeywords || [],
    movies,
  };
  writeFileSync(DATA_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`🎬 已写入 ${movies.length} 部影片 -> data/movies.json`);
}

main().catch(e => {
  console.error('脚本异常:', e);
  process.exit(1);
});
