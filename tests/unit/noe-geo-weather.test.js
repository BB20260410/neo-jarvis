import { describe, expect, it } from 'vitest';
import { describeWmoCode, fetchGeoWeather, formatGeoWeatherBrief, parseGeoResponse } from '../../src/context/NoeGeoWeather.js';

// 波次5 P2 测试：geo-weather（fetch 注入，不碰真网络）。

const fakeFetch = (geo, wx) => async (url) => ({
  json: async () => (/ip-api|ipinfo|ipapi|ipwho/.test(String(url)) ? geo : wx),
});

describe('describeWmoCode', () => {
  it('常见码映射', () => {
    expect(describeWmoCode(0)).toBe('晴');
    expect(describeWmoCode(2)).toBe('多云');
    expect(describeWmoCode(3)).toBe('阴');
    expect(describeWmoCode(63)).toBe('雨');
    expect(describeWmoCode(75)).toBe('雪');
    expect(describeWmoCode(95)).toBe('雷暴');
    expect(describeWmoCode(999)).toBe('未知天气');
  });
});

describe('parseGeoResponse（三种定位源形状归一，2026-06-10 实机逐源验证）', () => {
  it('ipapi 形状 latitude/longitude', () => {
    expect(parseGeoResponse({ city: 'X', latitude: 1.5, longitude: 2.5 })).toEqual({ lat: 1.5, lon: 2.5, city: 'X' });
  });
  it('ip-api.com 形状 lat/lon', () => {
    expect(parseGeoResponse({ city: 'Hong Kong', lat: 22.3, lon: 114.1 })).toEqual({ lat: 22.3, lon: 114.1, city: 'Hong Kong' });
  });
  it('ipinfo.io 形状 loc="纬,经" 字符串', () => {
    expect(parseGeoResponse({ city: 'Singapore', loc: '1.2897,103.8501' })).toEqual({ lat: 1.2897, lon: 103.8501, city: 'Singapore' });
  });
  it('限流/拒绝体解析为 null（如 CORS not supported / RateLimited）', () => {
    expect(parseGeoResponse({ success: false, message: 'CORS is not supported on the Free plan' })).toBe(null);
    expect(parseGeoResponse({ reason: 'RateLimited', error: true })).toBe(null);
    expect(parseGeoResponse(null)).toBe(null);
  });
});

describe('fetchGeoWeather', () => {
  it('定位+天气拼装', async () => {
    const gw = await fetchGeoWeather({
      fetchImpl: fakeFetch(
        { city: 'Beijing', latitude: 39.9, longitude: 116.4 },
        { current: { temperature_2m: 25.5, weather_code: 0, wind_speed_10m: 12 } },
      ),
    });
    expect(gw.city).toBe('Beijing');
    expect(gw.temperatureC).toBe(25.5);
    expect(gw.weather).toBe('晴');
    expect(gw.windKmh).toBe(12);
  });

  it('全部定位源失败才抛错（不静默给假数据）', async () => {
    await expect(fetchGeoWeather({ fetchImpl: fakeFetch({ error: true }, {}) })).rejects.toThrow(/定位失败/);
  });

  it('第一源限流(无经纬度) → fallback 第二源成功（2026-06-10 实机 ipapi.co RateLimited 教训）', async () => {
    const calls = [];
    const gw = await fetchGeoWeather({
      geoProviders: ['https://a.example/', 'https://b.example/'],
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).includes('a.example')) return { json: async () => ({ reason: 'RateLimited', error: true }) };
        if (String(url).includes('b.example')) return { json: async () => ({ city: 'Springs', latitude: 38.8, longitude: -104.8 }) };
        return { json: async () => ({ current: { temperature_2m: 20, weather_code: 1, wind_speed_10m: 5 } }) };
      },
    });
    expect(calls.filter((u) => u.includes('example'))).toHaveLength(2);   // 两源都试了
    expect(gw.city).toBe('Springs');
    expect(gw.weather).toBe('多云');
  });

  it('天气字段缺失 → null 不编数', async () => {
    const gw = await fetchGeoWeather({
      fetchImpl: fakeFetch({ city: 'X', latitude: 1, longitude: 1 }, { current: { weather_code: 3 } }),
    });
    expect(gw.temperatureC).toBe(null);
    expect(gw.windKmh).toBe(null);
    expect(gw.weather).toBe('阴');
  });
});

describe('formatGeoWeatherBrief', () => {
  it('完整 brief', () => {
    expect(formatGeoWeatherBrief({ city: '北京', temperatureC: 25, weather: '晴', windKmh: 10 }))
      .toBe('当前位置 北京，晴 25°C，风速 10 km/h');
  });
  it('缺城市/温度时优雅降级', () => {
    expect(formatGeoWeatherBrief({ city: '', temperatureC: null, weather: '阴', windKmh: null })).toBe('阴');
    expect(formatGeoWeatherBrief(null)).toBe('');
  });
});
