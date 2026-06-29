// Generates a nested sample/ folder of test images to exercise the pipeline.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve('./sample');
const folders = {
  '2024/Tokyo': ['shibuya', 'tower', 'ramen', 'station', 'temple'],
  '2024/Kyoto': ['fushimi', 'bamboo', 'geisha'],
  '2023/Beach': ['sunset', 'waves', 'sand', 'boat'],
  'Family': ['picnic', 'birthday', 'garden', 'dog', 'cake', 'park'],
};
const palette = ['#e8a33d', '#3da5e8', '#7d3de8', '#3de88f', '#e83d6b', '#e8d23d'];

function svg(label, sub, w, h, color) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="100%" height="100%" fill="${color}"/>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <defs><radialGradient id="g" cx="30%" cy="25%"><stop offset="0%" stop-color="#ffffff55"/><stop offset="100%" stop-color="#00000033"/></radialGradient></defs>
      <text x="50%" y="48%" font-family="sans-serif" font-size="${Math.round(w/9)}" fill="#ffffff" text-anchor="middle" font-weight="bold">${label}</text>
      <text x="50%" y="62%" font-family="sans-serif" font-size="${Math.round(w/22)}" fill="#ffffffcc" text-anchor="middle">${sub}</text>
    </svg>`
  );
}

await fs.rm(root, { recursive: true, force: true });
let n = 0;
for (const [folder, names] of Object.entries(folders)) {
  const dir = path.join(root, folder);
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < names.length; i++) {
    const landscape = (i % 3) !== 0;
    const w = landscape ? 1600 : 1080;
    const h = landscape ? 1067 : 1440;
    const color = palette[(n) % palette.length];
    await sharp(svg(names[i], `${folder}`, w, h, color))
      .jpeg({ quality: 80 })
      .toFile(path.join(dir, `${String(i + 1).padStart(2, '0')}_${names[i]}.jpg`));
    n++;
  }
}
console.log(`Created ${n} sample images under ${root}`);
