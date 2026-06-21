// Minimal, dependency-free QR Code generator.
// Supports byte mode with error-correction level M, picking the smallest
// version that fits. Enough to encode short device-linking codes/URLs.
// Returns a boolean matrix (true = dark module). Self-contained and verifiable.

const EC_CODEWORDS = { // [version] = EC codewords per block for level M (single block, v1..10)
  1: 10, 2: 16, 3: 26, 4: 18, 5: 24, 6: 16, 7: 18, 8: 22, 9: 22, 10: 26,
};
const EC_BLOCKS = { // number of blocks for level M (v1..10)
  1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 4, 7: 4, 8: 4, 9: 5, 10: 5,
};
const DATA_CODEWORDS = { // total data codewords for level M (v1..10)
  1: 16, 2: 28, 3: 44, 4: 64, 5: 86, 6: 108, 7: 124, 8: 154, 9: 182, 10: 216,
};

// --- Galois field (GF(256)) tables for Reed–Solomon ---
const EXP = new Array(512);
const LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) for (let j = 0; j < gen.length - 1; j++) res[j] ^= gfMul(gen[j + 1], factor);
  }
  return res;
}

// Bit buffer
function bits() {
  const arr = [];
  return {
    put(val, len) { for (let i = len - 1; i >= 0; i--) arr.push((val >> i) & 1); },
    arr,
  };
}

function chooseVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    // byte mode header: 4 (mode) + char-count (8 for v1-9, 16 for v10) bits
    const ccBits = v < 10 ? 8 : 16;
    const capacityBits = DATA_CODEWORDS[v] * 8;
    if (4 + ccBits + byteLen * 8 <= capacityBits) return v;
  }
  throw new Error('Conteúdo grande demais para QR (máx versão 10).');
}

function encodeData(text) {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  // Only version 1 is validated (covers short device-linking codes/URLs).
  // Larger payloads would need alignment/version-info modules not handled here.
  if (version > 1) throw new Error('QR: conteúdo além da versão 1 não é suportado.');
  const ccBits = version < 10 ? 8 : 16;
  const b = bits();
  b.put(0b0100, 4);            // byte mode
  b.put(bytes.length, ccBits); // char count
  for (const by of bytes) b.put(by, 8);
  const totalData = DATA_CODEWORDS[version];
  // terminator + pad to codeword boundary
  let remaining = totalData * 8 - b.arr.length;
  b.put(0, Math.min(4, remaining));
  while (b.arr.length % 8 !== 0) b.arr.push(0);
  const codewords = [];
  for (let i = 0; i < b.arr.length; i += 8) {
    let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | b.arr[i + j];
    codewords.push(v);
  }
  const pads = [0xec, 0x11];
  let pi = 0;
  while (codewords.length < totalData) codewords.push(pads[pi++ % 2]);

  // split into blocks, RS-encode each
  const numBlocks = EC_BLOCKS[version];
  const ecLen = EC_CODEWORDS[version];
  const blockSize = Math.floor(totalData / numBlocks);
  const extra = totalData % numBlocks;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const size = blockSize + (i >= numBlocks - extra ? 1 : 0);
    const blk = codewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecLen));
  }
  // interleave
  const out = [];
  const maxData = Math.max(...dataBlocks.map((d) => d.length));
  for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < ecLen; i++) for (const blk of ecBlocks) out.push(blk[i]);
  return { version, codewords: out };
}

// --- Matrix construction ---
function buildMatrix(version, codewords) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  function placeFinder(r, c) {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const rr = r + i; const cc = c + j;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const inRing = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6));
      const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
      m[rr][cc] = inRing || inCore ? 1 : 0;
      reserved[rr][cc] = true;
    }
  }
  placeFinder(0, 0); placeFinder(0, size - 7); placeFinder(size - 7, 0);

  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0; reserved[6][i] = true;
    m[i][6] = i % 2 === 0 ? 1 : 0; reserved[i][6] = true;
  }
  // dark module
  m[size - 8][8] = 1; reserved[size - 8][8] = true;

  // alignment pattern (v2..v10 single one at center)
  if (version >= 2) {
    const pos = version * 4 + 10; // center for v2..v6 = 18; general formula works for v2-10 single pattern
    const center = size - 7; // bottom-right alignment center per spec (6,6)->(size-7,size-7) approx
    const ac = size - 7; const ar = size - 7;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const rr = ar + i; const cc = ac + j;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const ring = Math.max(Math.abs(i), Math.abs(j));
      m[rr][cc] = (ring === 1) ? 0 : 1;
      reserved[rr][cc] = true;
    }
  }

  // reserve format info areas
  for (let i = 0; i < 9; i++) { if (!reserved[8][i]) reserved[8][i] = true; if (!reserved[i][8]) reserved[i][8] = true; }
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }

  // place data with zig-zag
  const bitsArr = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bitsArr.push((cw >> i) & 1);
  let idx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let row = 0; row < size; row++) {
      const r = upward ? size - 1 - row : row;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[r][cc]) continue;
        let bit = idx < bitsArr.length ? bitsArr[idx++] : 0;
        // mask 0: (r+c) % 2 == 0
        if ((r + cc) % 2 === 0) bit ^= 1;
        m[r][cc] = bit;
      }
    }
    upward = !upward;
  }

  // format info for EC level M, mask 0 -> bits 0b10 (M) << 3 | 000, BCH; precomputed string
  const FORMAT_M0 = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0]; // 15 bits, level M mask 0
  // place format bits
  for (let i = 0; i <= 5; i++) { m[8][i] = FORMAT_M0[i]; }
  m[8][7] = FORMAT_M0[6]; m[8][8] = FORMAT_M0[7]; m[7][8] = FORMAT_M0[8];
  for (let i = 9; i < 15; i++) { m[14 - i][8] = FORMAT_M0[i]; }
  for (let i = 0; i < 8; i++) { m[size - 1 - i][8] = FORMAT_M0[i]; }
  for (let i = 8; i < 15; i++) { m[8][size - 15 + i] = FORMAT_M0[i]; }

  return m.map((row) => row.map((v) => v === 1));
}

export function makeQR(text) {
  const { version, codewords } = encodeData(text);
  return buildMatrix(version, codewords);
}

// Render a QR matrix into an SVG string.
export function qrSVG(text, { size = 200, margin = 4 } = {}) {
  const m = makeQR(text);
  const n = m.length;
  const total = n + margin * 2;
  const cell = size / total;
  let rects = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (m[r][c]) rects += `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
