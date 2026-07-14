export const aliases = {
  product: ["product","product name","name","produit","nom","model","modèle","المنتج","موديل"],
  color: ["color","colour","couleur","لون"],
  size: ["size","sizes","taille","pointure","مقاس","المقاس"],
  price: ["price","prix","السعر"],
  stock: ["stock","quantity","qty","quantité","المخزون","كمية"],
  image: ["image","image url","photo","photo url","صورة","رابط الصورة"],
  description: ["description","details","détails","الوصف"],
  wilaya: ["wilaya","province","state","ولاية","الولاية"],
  commune: ["commune","city","municipality","بلدية","البلدية"],
  home: ["home","home delivery","domicile","livraison domicile","توصيل للمنزل"],
  office: ["office","desk","bureau","stop desk","توصيل للمكتب"],
};

export const normalize = (v = "") =>
  String(v).trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function pick(row, key) {
  for (const a of aliases[key] || []) {
    const val = row[normalize(a)];
    if (val !== undefined && val !== "") return val;
  }
  return "";
}

// Extracts the first numeric token from a cell instead of stripping every
// non-digit blindly - avoids corrupting values like "500-700" or "1.200,50".
export function toNumber(v) {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const m = s.match(/\d[\d.,]*/);
  if (!m) return 0;
  let numStr = m[0];
  const lastComma = numStr.lastIndexOf(",");
  const lastDot = numStr.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    numStr = lastComma > lastDot ? numStr.replace(/\./g, "").replace(",", ".") : numStr.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = numStr.length - lastComma - 1;
    numStr = decimals === 1 || decimals === 2 ? numStr.replace(",", ".") : numStr.replace(/,/g, "");
  }
  const n = parseFloat(numStr);
  return Number.isFinite(n) ? n : 0;
}

// 1 -> A, 26 -> Z, 27 -> AA ...
export function colLetter(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function editDistanceWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length] <= max;
}
