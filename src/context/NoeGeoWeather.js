// NoeGeoWeather — IP 定位 + 天气（波次5 P2 接线，全程无 API key）。
//
// 链路：ipapi.co（IP→城市/经纬度）→ open-meteo.com（经纬度→当前天气，免费无 key）。
// 产出一句话 brief 进预取池 → 聊天上下文注入（任务2 已接）→ 问"今天天气"秒答不现查。
// fetch 注入可单测；server 侧 NOE_GEO_WEATHER=1 才通电（默认 OFF：涉及对第三方暴露出口 IP，opt-in）。

/** WMO 天气码 → 中文（open-meteo 用 WMO 标准码）。 */
export function describeWmoCode(code) {
  const n = Number(code);
  if (n === 0) return '晴';
  if (n === 1 || n === 2) return '多云';
  if (n === 3) return '阴';
  if (n === 45 || n === 48) return '雾';
  if (n >= 51 && n <= 57) return '毛毛雨';
  if (n >= 61 && n <= 67) return '雨';
  if (n >= 71 && n <= 77) return '雪';
  if (n >= 80 && n <= 82) return '阵雨';
  if (n === 85 || n === 86) return '阵雪';
  if (n >= 95 && n <= 99) return '雷暴';   // WMO 雷暴码 95-99，封上界防未定义码误判
  return '未知天气';
}

// IP 定位多源 fallback（2026-06-10 实机逐源验证）：
//   ipapi.co 免费档 RateLimited；ipwho.is 免费档拒绝 Node fetch 的 CORS 头（curl 通 Node 不通的坑）；
//   ip-api.com(http,字段 lat/lon) 与 ipinfo.io(字段 loc="纬,经") 实测对 Node fetch 都通。
// 注意固有局限：代理环境下定位到的是**网络出口**位置（如新加坡节点），非真实所在地。
const GEO_PROVIDERS = ['http://ip-api.com/json/', 'https://ipinfo.io/json'];

/** 归一三种定位响应形状 → {lat, lon, city}；解析不出经纬度返回 null。 */
export function parseGeoResponse(g) {
  if (!g || typeof g !== 'object') return null;
  let lat = Number(g.latitude ?? g.lat);
  let lon = Number(g.longitude ?? g.lon);
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && typeof g.loc === 'string') {
    const [la, lo] = g.loc.split(',').map(Number);   // ipinfo.io 的 "1.2897,103.8501"
    lat = la; lon = lo;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, city: String(g.city || g.region || '') };
}

/**
 * 抓当前位置 + 天气。
 * @returns {Promise<{city:string, temperatureC:number|null, weather:string, windKmh:number|null}>}
 */
export async function fetchGeoWeather({ fetchImpl = fetch, geoProviders = GEO_PROVIDERS } = {}) {
  let parsed = null;
  for (const url of geoProviders) {
    try {
      const g = await Promise.resolve(fetchImpl(url)).then((r) => (typeof r?.json === 'function' ? r.json() : r));
      parsed = parseGeoResponse(g);
      if (parsed) break;
    } catch { /* 该源失败试下一个 */ }
  }
  if (!parsed) throw new Error('IP 定位失败（所有定位源都没拿到经纬度）');
  const { lat, lon } = parsed;   // city 兜底已在 parseGeoResponse 内做（city||region），此处契约只有 {lat,lon,city}
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;
  const wx = await Promise.resolve(fetchImpl(url)).then((r) => (typeof r?.json === 'function' ? r.json() : r));
  const cur = wx?.current || {};
  return {
    city: parsed.city,
    temperatureC: Number.isFinite(Number(cur.temperature_2m)) ? Number(cur.temperature_2m) : null,
    weather: describeWmoCode(cur.weather_code),
    windKmh: Number.isFinite(Number(cur.wind_speed_10m)) ? Number(cur.wind_speed_10m) : null,
  };
}

/** 一句话 brief（进预取池/聊天上下文用）。 */
export function formatGeoWeatherBrief(gw) {
  if (!gw) return '';
  const parts = [];
  if (gw.city) parts.push(`当前位置 ${gw.city}`);
  parts.push(`${gw.weather}${gw.temperatureC != null ? ` ${gw.temperatureC}°C` : ''}`);
  if (gw.windKmh != null) parts.push(`风速 ${gw.windKmh} km/h`);
  return parts.join('，');
}
