const fs = require('fs');
const path = require('path');

const pngPath = path.resolve(__dirname, '../assets/palee-logo.png');
const svgAssetPath = path.resolve(__dirname, '../assets/palee-logo.svg');
const svgDocsPath = path.resolve(__dirname, '../docs/public/palee-logo.svg');

const pngBuffer = fs.readFileSync(pngPath);
const base64Png = pngBuffer.toString('base64');

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="100%" height="100%">
  <image width="1024" height="1024" href="data:image/png;base64,${base64Png}"/>
</svg>
`;

fs.writeFileSync(svgAssetPath, svgContent, 'utf-8');
fs.writeFileSync(svgDocsPath, svgContent, 'utf-8');
console.log('Successfully synchronized palee-logo.svg with palee-logo.png with 100% exact parity.');
