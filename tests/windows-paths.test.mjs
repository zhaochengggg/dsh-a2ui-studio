import test from 'node:test';
import assert from 'node:assert/strict';
import {localSshPath,sshNullFile} from '../machines/ssh-paths.mjs';
import {execFileSync} from 'node:child_process';
test('Windows local paths are literal, drive-qualified and slash-normalized',()=>{
 assert.equal(localSshPath('C:\\Users\\Test User\\密钥','win32'),'C:/Users/Test User/密钥');
 for(const p of ['C:relative','\\rooted','\\\\server\\share','\\\\?\\C:\\device','C:/x%h','C:/x\nHost evil','C:/x"','C:/x\0'])
  assert.throws(()=>localSshPath(p,'win32'));
 assert.equal(sshNullFile('win32'),'NUL');
 assert.equal(sshNullFile('linux'),'/dev/null');
 assert.equal(localSshPath('/root/key','linux'),'/root/key');
 assert.throws(()=>localSshPath('C:/key','linux'));
});
test('Windows OpenSSH parses spaced known-host and identity paths literally',{skip:process.platform!=='win32'},()=>{
 const s=execFileSync('ssh',['-F','NUL','-G','-o','UserKnownHostsFile="C:/Test User/known_hosts"','-o','IdentityFile="C:/Test User/key"','-o','GlobalKnownHostsFile=NUL','example.invalid'],{encoding:'utf8',windowsHide:true});
 assert.match(s,/userknownhostsfile C:\/Test User\/known_hosts/);
 assert.match(s,/identityfile C:\/Test User\/key/);
});
