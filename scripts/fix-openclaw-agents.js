const fs = require('fs');
const path = require('path');

function findOpenclawDist() {
  const pnpmDir = path.join(__dirname, '..', 'node_modules', '.pnpm');
  if (!fs.existsSync(pnpmDir)) {
    console.log('[fix-openclaw] pnpm directory not found at:', pnpmDir);
    return null;
  }

  const entries = fs.readdirSync(pnpmDir);
  console.log('[fix-openclaw] Found', entries.filter(e => e.startsWith('openclaw')).length, 'openclaw entries');

  const openclawEntry = entries.find(e => e.startsWith('openclaw@'));
  if (!openclawEntry) {
    console.log('[fix-openclaw] No openclaw entry found');
    return null;
  }

  console.log('[fix-openclaw] Found entry:', openclawEntry);

  const distPath = path.join(pnpmDir, openclawEntry, 'node_modules', 'openclaw', 'dist');
  console.log('[fix-openclaw] Checking dist path:', distPath);

  if (fs.existsSync(distPath)) {
    return distPath;
  }

  return null;
}

function fixOpenclawAgentsModule(distPath) {
  const agentsDir = path.join(distPath, 'agents');

  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
    console.log('[fix-openclaw] Created agents directory');
  }

  fs.writeFileSync(
    path.join(agentsDir, 'auth-profiles.runtime.js'),
    `export { t as ensureAuthProfileStore } from "../auth-profiles.runtime-a3MaNQM3.js";\n`
  );
  console.log('[fix-openclaw] Fixed: agents/auth-profiles.runtime.js');

  fs.writeFileSync(
    path.join(agentsDir, 'model-catalog.runtime.js'),
    `export * from "../model-catalog.runtime-BSOGShYk.js";\n`
  );
  console.log('[fix-openclaw] Fixed: agents/model-catalog.runtime.js');

  let authProfilesContent = fs.readFileSync(
    path.join(distPath, 'auth-profiles.runtime-a3MaNQM3.js'),
    'utf-8'
  );
  authProfilesContent = authProfilesContent.replace(/from "\.\//g, 'from "../');
  fs.writeFileSync(path.join(agentsDir, 'auth-profiles.runtime-a3MaNQM3.js'), authProfilesContent);
  console.log('[fix-openclaw] Fixed: agents/auth-profiles.runtime-a3MaNQM3.js');

  let modelCatalogContent = fs.readFileSync(
    path.join(distPath, 'model-catalog.runtime-BSOGShYk.js'),
    'utf-8'
  );
  modelCatalogContent = modelCatalogContent.replace(/from "\.\//g, 'from "../');
  fs.writeFileSync(path.join(agentsDir, 'model-catalog.runtime-BSOGShYk.js'), modelCatalogContent);
  console.log('[fix-openclaw] Fixed: agents/model-catalog.runtime-BSOGShYk.js');

  console.log('[fix-openclaw] OpenClaw agents module fix applied successfully');
}

function main() {
  console.log('[fix-openclaw] Looking for openclaw dist directory...');
  const distPath = findOpenclawDist();

  if (!distPath) {
    console.log('[fix-openclaw] OpenClaw dist not found, skipping fix');
    return;
  }

  console.log(`[fix-openclaw] Found openclaw dist at: ${distPath}`);
  fixOpenclawAgentsModule(distPath);
}

main();
