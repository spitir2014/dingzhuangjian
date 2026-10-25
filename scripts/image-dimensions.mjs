/* Inspect encoded pixels, never infer resolution from a request or upstream metadata. */
export function imageDimensions(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 4 && buf[0] === 255 && buf[1] === 216) {
    let at = 2;
    const frames = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    while (at + 4 <= buf.length) {
      if (buf[at] !== 255) { at++; continue; }
      while (buf[at] === 255) at++;
      const marker = buf[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (at + 2 > buf.length) break;
      const size = buf.readUInt16BE(at);
      if (size < 2 || at + size > buf.length) break;
      if (frames.has(marker) && size >= 7) return { width: buf.readUInt16BE(at + 5), height: buf.readUInt16BE(at + 3) };
      at += size;
    }
  }
  if (buf.length >= 30 && buf.toString('ascii',0,4)==='RIFF' && buf.toString('ascii',8,12)==='WEBP') {
    const type=buf.toString('ascii',12,16);
    if(type==='VP8X')return {width:buf.readUIntLE(24,3)+1,height:buf.readUIntLE(27,3)+1};
    if(type==='VP8L' && buf[20]===0x2f){const bits=buf.readUInt32LE(21);return {width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};}
    if(type==='VP8 ' && buf[23]===0x9d && buf[24]===0x01 && buf[25]===0x2a)return {width:buf.readUInt16LE(26)&0x3fff,height:buf.readUInt16LE(28)&0x3fff};
  }
  return null;
}
