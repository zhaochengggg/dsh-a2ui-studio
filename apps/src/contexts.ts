/** Resolve execution worlds without duplicating machine SSH configuration. @module @deepseek-ai/dsh-app-cards/contexts */

import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { MachineManagementService } from '../../machines/contracts.ts'
import { digest } from './digest.ts'
import { AppCardError } from './errors.ts'
import type { CardDeclaration, ResolvedContext } from './types.ts'

/** Resolve and verify the context facts shown in a declaration review.
 * @param declaration - parsed document.
 * @param machineMgmt - existing infrastructure service.
 * @param hostRoots - explicitly configured local working-directory roots.
 * @param maxBytes - maximum configuration file bytes.
 * @returns concrete contexts whose identity is bound by the grant.
 */
export async function resolveContexts(
  declaration: CardDeclaration,
  machineMgmt: Pick<MachineManagementService, 'list' | 'inspect'>,
  hostRoots: readonly string[],
  maxBytes: number,
): Promise<Record<string, ResolvedContext>> {
  const inventory = await machineMgmt.list()
  if (!inventory.machines.some(machine => machine.id === declaration.machineId && !machine.archived)) {
    throw new AppCardError('MACHINE_MISSING', 'Application cards require an existing declared machine')
  }
  const needsSsh = Object.values(declaration.contexts).some(context => context.kind === 'ssh')
  const inspection = needsSsh ? await machineMgmt.inspect({machine_id: declaration.machineId}) : undefined
  const contexts: Record<string, ResolvedContext> = {}
  for (const [id, context] of Object.entries(declaration.contexts)) {
    if (context.kind === 'host') {
      const cwd = await realpath(context.cwd)
      const roots = await Promise.all(hostRoots.map(root => realpath(root)))
      if (!roots.some((root) => {
        const child = relative(root, cwd)
        return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
      })) {
        throw new AppCardError('HOST_CONTEXT_DISABLED', `Host directory ${context.cwd} is outside configured hostRoots`)
      }
      const info = await lstat(cwd)
      if (!info.isDirectory()) throw new AppCardError('CONTEXT_INVALID', 'Host working directory must be a directory')
      contexts[id] = {
        kind: 'host', cwd, argvPrefix: [],
        identity: digest({ kind: 'host', cwd, device: info.dev, inode: info.ino }),
        display: `DSH Host · ${cwd}`,
      }
      continue
    }
    const path = inspection?.connections.find(entry => entry.id === context.pathId)
    if (path === undefined || !path.fingerprint || !Array.isArray(path.command)) {
      throw new AppCardError('SSH_UNAVAILABLE', `SSH path ${context.pathId} is missing or not verified; no alternative path will be used`)
    }
    const config = await privateConfig(path.command[2], maxBytes)
    const alias = path.command[3]
    const lines = config.split(/\r?\n/u)
    const at = lines.findIndex(line => line === `Host ${alias}`)
    if (at < 0) throw new AppCardError('SSH_CHANGED', 'The verified SSH alias disappeared')
    const next = lines.findIndex((line, index) => index > at && line.startsWith('Host '))
    const block = lines.slice(at, next < 0 ? undefined : next)
    const hostsLine = block.find(line => line.trimStart().startsWith('UserKnownHostsFile '))
    const hostsPath = hostsLine?.trim().slice('UserKnownHostsFile '.length).replace(/^"(.*)"$/, '$1')
    if (hostsPath === undefined || !isAbsolute(hostsPath)) {
      throw new AppCardError('SSH_CHANGED', 'The software-owned SSH alias has no absolute known-hosts file')
    }
    const enrolled = (await privateConfig(hostsPath, maxBytes)).split(/\r?\n/u)
      .filter(line => line.split(/\s/u)[0]?.split(',').includes(alias))
    if (enrolled.length === 0) throw new AppCardError('SSH_CHANGED', 'The verified SSH host identity disappeared')
    contexts[id] = {
      kind: 'ssh', cwd: context.cwd, argvPrefix: path.command,
      identity: digest({ block, enrolled, cwd: context.cwd, pathId: path.id }),
      display: `${declaration.machineId} · SSH ${path.id} · ${path.user}@${path.host}:${path.port}`,
    }
  }
  return contexts
}

async function privateConfig(path: string, maxBytes: number): Promise<string> {
  if (path.split(/[\\/]/u).includes('.ssh')) {
    throw new AppCardError('UNSAFE_SSH_CONFIG', 'Application execution never reads user .ssh files')
  }
  const info = await lstat(path)
  if (!info.isFile() || info.size > maxBytes) throw new AppCardError('SSH_CONFIG_LIMIT', 'Invalid or oversized software-owned SSH configuration')
  const value = await readFile(path, 'utf8')
  if (Buffer.byteLength(value) > maxBytes) throw new AppCardError('SSH_CONFIG_LIMIT', 'Software-owned SSH configuration exceeds the configured limit')
  return value
}
