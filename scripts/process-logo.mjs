import { app, nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'

app.whenReady().then(() => {
  const inputJpg = path.resolve('src/renderer/src/assets/logo.jpg')
  const img = nativeImage.createFromPath(inputJpg)
  const size = img.getSize()

  const bmp = img.toBitmap() // BGRA buffer
  const totalPixels = size.width * size.height
  const outBuf = Buffer.from(bmp)

  // Transparency threshold
  for (let i = 0; i < totalPixels * 4; i += 4) {
    const b = bmp[i]
    const g = bmp[i + 1]
    const r = bmp[i + 2]
    if (r > 235 && g > 235 && b > 235) {
      const minVal = Math.min(r, g, b)
      const alpha = Math.max(0, 255 - minVal) * 4
      outBuf[i + 3] = Math.min(255, alpha)
    }
  }

  const transparentImg = nativeImage.createFromBitmap(outBuf, {
    width: size.width,
    height: size.height
  })

  // Full logo
  const pngBuffer = transparentImg.toPNG()
  fs.writeFileSync('src/renderer/src/assets/logo.png', pngBuffer)

  // Crop the K emblem precisely:
  // K width: 0 to 260
  // Height: 0 to 365
  const cropW = 260
  const cropH = 365
  const crop = transparentImg.crop({ x: 0, y: 0, width: cropW, height: cropH })
  const cropBmp = crop.toBitmap()

  // Clean bottom line if y > 340 and x > 50
  for (let y = 330; y < cropH; y++) {
    for (let x = 60; x < cropW; x++) {
      const idx = (y * cropW + x) * 4
      cropBmp[idx + 3] = 0 // transparent
    }
  }

  const cleanedCrop = nativeImage.createFromBitmap(cropBmp, { width: cropW, height: cropH })

  const targetSize = 256
  const maxDim = Math.max(cropW, cropH)
  const scale = (targetSize - 20) / maxDim
  const scaledW = Math.round(cropW * scale)
  const scaledH = Math.round(cropH * scale)

  const scaled = cleanedCrop.resize({ width: scaledW, height: scaledH, quality: 'best' })
  const scaledBmp = scaled.toBitmap()

  const squareBuf = Buffer.alloc(targetSize * targetSize * 4)
  const xOffset = Math.floor((targetSize - scaledW) / 2)
  const yOffset = Math.floor((targetSize - scaledH) / 2)

  for (let y = 0; y < scaledH; y++) {
    for (let x = 0; x < scaledW; x++) {
      const srcIdx = (y * scaledW + x) * 4
      const destIdx = ((y + yOffset) * targetSize + (x + xOffset)) * 4
      squareBuf[destIdx] = scaledBmp[srcIdx]
      squareBuf[destIdx + 1] = scaledBmp[srcIdx + 1]
      squareBuf[destIdx + 2] = scaledBmp[srcIdx + 2]
      squareBuf[destIdx + 3] = scaledBmp[srcIdx + 3]
    }
  }

  const squareImg = nativeImage.createFromBitmap(squareBuf, { width: targetSize, height: targetSize })
  fs.writeFileSync('src/renderer/src/assets/emblem.png', squareImg.toPNG())

  const buildDir = path.resolve('build')
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true })
  fs.writeFileSync(path.join(buildDir, 'icon.png'), squareImg.toPNG())

  console.log('Saved refined emblem!')
  app.quit()
})
