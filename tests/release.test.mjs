import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
test('one standalone bundle, without migration utilities or legacy packages', async () => {
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.name,'dsh-control-studio');
  assert.equal(pkg.engines.dsh,'0.2.1-alpha.1 || 0.2.1-rc.2');
  assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');
  const patch=await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8');
  assert.match(patch,/id: machine-apps/); // Stable config identity across the package rename.
  assert.match(patch,/name: dsh-control-studio/);
  for(const path of pkg.files) assert.doesNotMatch(path,/scripts\/profile|app-cards-v2|machine-mgmt-chips|evidence|RELEASE/);
  for(const name of Object.keys({...pkg.dependencies,...pkg.peerDependencies,...pkg.devDependencies})) assert.ok(!name.startsWith('@local/'));
});
