/** Local SSH paths, not paths on the remote machine. Never expand SSH tokens. */
export function localSshPath(value, platform=process.platform) {
  if(typeof value!=='string'||/[\x00-\x1f\x7f"%]/.test(value))throw new Error('Identity must be a literal absolute path');
  if(platform==='win32'){
    // Require a drive-qualified local path; reject drive-relative, UNC and device paths.
    if(!/^[a-z]:[\\/]/i.test(value))throw new Error('Identity must be a literal absolute path');
    return value.replaceAll('\\','/');
  }
  if(!value.startsWith('/')||value.includes('\\'))throw new Error('Identity must be a literal absolute path');
  return value;
}
export const sshNullFile=(platform=process.platform)=>platform==='win32'?'NUL':'/dev/null';
export const sshOptionPath=(value)=>`"${localSshPath(value)}"`;
