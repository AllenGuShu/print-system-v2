// lib/pricing.js — v2: 加入「其他/無法判斷」的異常標記

const PRINT_TYPES = {
  '膠裝A4（上字封面）':       { bind: 16,  cover: 6.5 },
  '膠裝A4（牛皮紙封面）':     { bind: 16,  cover: 6.5 },
  '膠裝A4（自備無上字）':     { bind: 16,  cover: 4.5 },
  '膠裝A4（許豪自備封面）':   { bind: 16,  cover: 3.0 },
  '膠裝A4（許錡加工封面）':   { bind: 16,  cover: 4.5 },
  '騎馬釘A3（牛皮紙封面）':   { bind: 0,   cover: 8.0 },
  '騎馬釘A3（上字封面）':     { bind: 0,   cover: 8.5 },
  '騎馬釘A3（無封面）':       { bind: 3,   cover: 0   },
  '騎馬釘A3（許錡自備封面）': { bind: 0,   cover: 8.5 },
  '騎馬釘B4（牛皮紙封面）':   { bind: 0,   cover: 6.5 },
  '騎馬釘B4（上字封面）':     { bind: 0,   cover: 6.5 },
  '騎馬釘B4（自備封面）':     { bind: 0,   cover: 6.5 },
  '騎馬釘B4（無封面）':       { bind: 6.5, cover: 0   },
  '騎馬釘A4（牛皮紙封面）':   { bind: 0,   cover: 5.0 },
  '騎馬釘A4（上字封面）':     { bind: 0,   cover: 5.0 },
  '騎馬釘A4（無封面）':       { bind: 3,   cover: 0   },
  'A4左側兩釘（無封面）':     { bind: 3,   cover: 0   },
  'A3左側兩釘（無封面）':     { bind: 3,   cover: 0   },
  'B4左側兩釘（無封面）':     { bind: 3,   cover: 0   },
  'B5單張/頭條/每週一翻':     { bind: 0,   cover: 0, fixedRate: 2.5 },
  'A5單張（無封面）':         { bind: 0,   cover: 0   },
  'A4單面（無封面）':         { bind: 0,   cover: 0   },
  'B4單面（無封面）':         { bind: 0,   cover: 0   },
  'A3單面（無封面）':         { bind: 0,   cover: 0   },
  'A4雙面（無裝訂）':         { bind: 0,   cover: 0   },
  'B4雙面（無裝訂）':         { bind: 0,   cover: 0   },
  'A3雙面（無裝訂）':         { bind: 0,   cover: 0   },
  '彩色印刷A4單面':           { bind: 0,   cover: 0, fixedRate: 4   },
  'A5單面彩色頭條新聞':       { bind: 0,   cover: 0, fixedRate: 1.25 },
  '彩色文宣DM-A4':            { bind: 0,   cover: 0, fixedRate: 4.5 },
  '彩色文宣DM-B4':            { bind: 0,   cover: 0, fixedRate: 6.5 },
  '叫紙A4（每包$90）':        { bind: 0,   cover: 0, fixedRate: 90  },
  '叫紙B4（每包$135）':       { bind: 0,   cover: 0, fixedRate: 135 },
  '叫紙A3（每包$175）':       { bind: 0,   cover: 0, fixedRate: 175 },
};

const PAPER_RATES = {
  A4: [[50,1.8],[100,1.5],[300,1.3],[1000,1.1],[Infinity,0.9]],
  A3: [[50,2.5],[100,2.3],[300,2.0],[1000,1.85],[Infinity,1.65]],
  B4: [[50,2.2],[100,2.0],[300,1.8],[1000,1.65],[Infinity,1.55]],
  B5: [[50,1.2],[100,1.0],[300,0.9],[1000,0.85],[Infinity,0.8]],
  A5: [[50,1.0],[100,0.8],[Infinity,0.75]],
};

const ROOMS = [
  "大里許豪教室", "大里育豪教室", "苑裡勁學教室", "員林教室", "其他教室（備註）",
];

function getSize(printType) {
  if (printType.includes("A3")) return "A3";
  if (printType.includes("B4")) return "B4";
  if (printType.includes("B5")) return "B5";
  if (printType.includes("A5")) return "A5";
  return "A4";
}

function getSheets(printType, pages) {
  const p = Math.ceil(Number(pages) || 0);
  const direct = ["B5單張", "彩色", "叫紙"];
  if (direct.some(k => printType.includes(k))) return p;
  const saddle = ["騎馬釘A3", "騎馬釘B4", "騎馬釘A4"];
  if (saddle.some(k => printType.includes(k))) return Math.ceil(p / 4);
  const single = ["A4單面", "B4單面", "A3單面"];
  if (single.some(k => printType.includes(k))) return p;
  return Math.ceil(p / 2);
}

function getPaperRate(size, totalSheets) {
  const tiers = PAPER_RATES[size] || PAPER_RATES.A4;
  for (const [limit, rate] of tiers) {
    if (totalSheets <= limit) return rate;
  }
  return tiers[tiers.length - 1][1];
}

// 某些印刷類型的「自備封面」價格只給特定老師本人使用
// 若其他老師誤選，伺服器端會強制改用一般上字封面計價，避免漏算封面費
const TEACHER_LOCKED_TYPES = {
  '膠裝A4（許豪自備封面）':   { prefix: '許豪老師', fallback: '膠裝A4（上字封面）' },
  '膠裝A4（許錡加工封面）':   { prefix: '許錡老師', fallback: '膠裝A4（上字封面）' },
  '騎馬釘A3（許錡自備封面）': { prefix: '許錡老師', fallback: '騎馬釘A3（上字封面）' },
};

function resolveTeacherLockedType(printType, teacher) {
  const rule = TEACHER_LOCKED_TYPES[printType];
  if (!rule) return printType;
  teacher = (teacher || '').toString();
  if (teacher.startsWith(rule.prefix)) return printType;
  return rule.fallback;
}

// calcPrice 回傳新增 needsReview 欄位：true = 無法自動判斷，金額不可信
// teacher 參數用於自動修正「特定老師專用封面」類型，避免其他老師誤用而漏算封面費
function calcPrice(printType, pages, qty, teacher) {
  pages = Number(pages) || 0;
  qty   = Number(qty)   || 0;

  // 伺服器端強制修正：確保 teacher-locked 類型只有本人才能套用優惠封面費
  printType = resolveTeacherLockedType(printType, teacher);

  // 沒有選印刷類型，或找不到對應價格 → 標記需人工確認
  const info = PRINT_TYPES[printType];
  if (!printType || !info) {
    return { sheets: 0, rate: 0, unit: 0, total: 0, needsReview: true, reviewReason: '印刷類型未對應' };
  }
  if (pages <= 0 || qty <= 0) {
    return { sheets: 0, rate: 0, unit: 0, total: 0, needsReview: true, reviewReason: '數量或頁數為0' };
  }

  const sheets = getSheets(printType, pages);

  if (info.fixedRate !== undefined) {
    return { sheets, rate: info.fixedRate, unit: info.fixedRate, total: Math.round(info.fixedRate * qty), needsReview: false, resolvedType: printType };
  }

  const size   = getSize(printType);
  const rate   = getPaperRate(size, sheets * qty);
  const paper  = sheets * rate;
  const unit   = Math.round((paper + info.bind + info.cover) * 10) / 10;
  const total  = Math.round(unit * qty);
  return { sheets, rate, unit, total, needsReview: false, resolvedType: printType };
}

module.exports = { PRINT_TYPES, PAPER_RATES, ROOMS, getSize, getSheets, getPaperRate, calcPrice, resolveTeacherLockedType };
