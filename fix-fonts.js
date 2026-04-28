const fs = require('fs');
const path = require('path');

function walk(dir) {
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      walk(p);
    } else if (p.endsWith('.tsx') || p.endsWith('.ts')) {
      let c = fs.readFileSync(p, 'utf8');
      if (c.includes('Georgia')) {
        c = c.replace(/ style=\{\{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' \}\}/g, '');
        fs.writeFileSync(p, c);
      }
    }
  });
}

walk('src');
console.log('Done!');
