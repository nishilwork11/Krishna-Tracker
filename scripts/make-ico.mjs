import fs from 'fs'
import path from 'path'

// An ICO file can wrap PNG images directly.
// Structure:
// ICONDIR (6 bytes): reserved (0), type (1 = icon), count (N)
// ICONDIRENTRY (16 bytes each):
//   width (1 byte, 0 = 256)
//   height (1 byte, 0 = 256)
//   colorCount (1 byte, 0)
//   reserved (1 byte, 0)
//   planes (2 bytes, 1)
//   bitCount (2 bytes, 32)
//   bytesInRes (4 bytes)
//   imageOffset (4 bytes)
// Image data (PNG buffer)

export function makeIco(pngBuffers) {
  const count = pngBuffers.length
  const headerSize = 6 + count * 16
  let offset = headerSize

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(count, 4) // number of images

  const entries = []
  for (const { width, height, buffer } of pngBuffers) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(width >= 256 ? 0 : width, 0)
    entry.writeUInt8(height >= 256 ? 0 : height, 1)
    entry.writeUInt8(0, 2) // color count
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bpp
    entry.writeUInt32LE(buffer.length, 8) // size
    entry.writeUInt32LE(offset, 12) // offset
    entries.push(entry)
    offset += buffer.length
  }

  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.buffer)])
}

// Test / execute if run directly
const pngPath = path.resolve('build/icon.png')
if (fs.existsSync(pngPath)) {
  const buf = fs.readFileSync(pngPath)
  const icoBuf = makeIco([{ width: 256, height: 256, buffer: buf }])
  fs.writeFileSync('build/icon.ico', icoBuf)
  console.log('Successfully generated build/icon.ico:', icoBuf.length, 'bytes')
}
