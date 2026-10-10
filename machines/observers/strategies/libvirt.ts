/**
 * Bounded read-only libvirt domain inspection and capability reporting.
 *
 * @module dsh-machine-apps/machines/strategies/libvirt
 */

import { XMLParser } from 'fast-xml-parser'
import type {
  MachineCapability,
  MachineCapabilityState,
  MachineDescriptor,
  MachineFact,
} from '../types.ts'
import type { ProbeResult, ReadOnlyProbeRunner } from './runner.ts'
import {
  aggregateOutputHash as aggregateProbeOutputHash,
  parseKeyValueLines,
  safeVirshOperand,
  type LabeledOutputHash,
} from './libvirt-readonly.ts'
import type {
  MachineStrategy,
  StrategyInspection,
  StrategyPrerequisites,
  StrategyTarget,
} from './strategy.ts'
import { MACHINE_CAPABILITY_NAMES } from './strategy.ts'

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
})

const LIBVIRT_STATES = new Set([
  'blocked',
  'crashed',
  'idle',
  'in shutdown',
  'no state',
  'paused',
  'pmsuspended',
  'running',
  'shut off',
])

const MAX_FACT_VALUE_CHARACTERS = 240

interface DomainState {
  readonly state: string
  readonly reason?: string
}

interface BlockRow {
  readonly type: string
  readonly device: string
  readonly target: string
  readonly source: string
}

interface BlockInfo {
  readonly capacityBytes?: number
}

interface InterfaceRow {
  readonly name: string
  readonly type: string
  readonly source: string
  readonly model: string
  readonly mac: string
}

interface InterfaceAddress {
  readonly protocol: string
  readonly address: string
}

interface StorageVolumeReference {
  readonly pool?: string
  readonly volume: string
}

interface InactiveDomainFacts {
  readonly diskCount: number
  readonly interfaceCount: number
  readonly expectedUuidMatches?: boolean
  readonly volumes: readonly StorageVolumeReference[]
  readonly truncated: boolean
}

interface ParsedRows<T> {
  readonly rows: readonly T[]
  readonly truncated: boolean
}

type ProbeAttempt =
  | { readonly kind: 'result'; readonly result: ProbeResult }
  | { readonly kind: 'error' }

type LabeledHash = LabeledOutputHash

type InspectionCapabilityState =
  | Extract<MachineCapabilityState, { readonly status: 'supported' }>
  | Extract<MachineCapabilityState, { readonly status: 'unavailable' }>
  | Extract<MachineCapabilityState, { readonly status: 'deferred' }>

/** Deployment-owned libvirt executable, probe location, and collection bound. */
export interface LibvirtStrategyOptions {
  readonly executable: string
  readonly probeCwd: string
  readonly maxCollectionItems: number
}

/** Read-only libvirt strategy; every target command is a fixed `virsh` query. */
export class LibvirtStrategy implements MachineStrategy {
  readonly kind = 'libvirt' as const

  /**
   * @param probes - bounded DSH subprocess runner.
   * @param options - executable, working directory, and per-inspection item bound.
   */
  constructor(
    private readonly probes: ReadOnlyProbeRunner,
    private readonly options: LibvirtStrategyOptions,
  ) {}

  /** @inheritdoc */
  validateDescriptor(descriptor: MachineDescriptor): readonly string[] {
    if (descriptor.strategy.kind !== this.kind) return ['libvirt strategy received a non-libvirt declaration']
    if (descriptor.strategy.uri.trim() === '') return ['strategy.uri must be non-empty']
    if (descriptor.strategy.domainName.trim() === '') return ['strategy.domainName must be non-empty']
    if (descriptor.strategy.domainName.startsWith('-')) {
      return ['strategy.domainName must not begin with a hyphen']
    }
    return []
  }

  /** @inheritdoc */
  async probePrerequisites(signal?: AbortSignal): Promise<StrategyPrerequisites> {
    try {
      const result = await this.probes.run([this.options.executable, '--version'], this.options.probeCwd, signal)
      if (!result.ok) {
        return {
          available: false,
          reason: `virsh prerequisite probe failed (${exitDescription(result)})`,
          outputHash: result.outputHash,
        }
      }
      const evidence = virshVersionEvidence(result.stdout || result.stderr)
      return {
        available: true,
        reason: 'virsh is available for fixed read-only libvirt inspection',
        ...(evidence === undefined ? {} : { evidence }),
        outputHash: result.outputHash,
      }
    } catch {
      signal?.throwIfAborted()
      return { available: false, reason: 'virsh prerequisite probe could not run' }
    }
  }

  /** @inheritdoc */
  async inspect(target: StrategyTarget, signal?: AbortSignal): Promise<StrategyInspection> {
    const descriptor = target.descriptor
    if (descriptor?.strategy.kind !== this.kind) {
      const reason = descriptor === undefined
        ? 'A declared libvirt URI and domain name are required for inspection.'
        : 'The target does not contain a libvirt descriptor.'
      return {
        reachability: 'unknown',
        summary: `Libvirt target ${target.displayName} was not contacted: ${reason}`,
        capabilities: unavailableCapabilities(reason),
      }
    }
    const descriptorFailures = this.validateDescriptor(descriptor)
    if (descriptorFailures.length > 0) {
      const reason = 'The libvirt descriptor is not safe for fixed argument-vector inspection.'
      return inspectionUnavailable(target, reason, [])
    }

    const prerequisites = await this.probePrerequisites(signal)
    const hashes: LabeledHash[] = []
    if (prerequisites.outputHash !== undefined) {
      hashes.push({ label: 'virsh-version', hash: prerequisites.outputHash })
    }
    if (!prerequisites.available) {
      return {
        reachability: 'unknown',
        summary: `Libvirt target ${target.displayName} was not contacted: ${prerequisites.reason}.`,
        ...(hashes.length === 0 ? {} : { outputHash: aggregateOutputHash(hashes) }),
        capabilities: this.capabilities(target, prerequisites),
      }
    }

    const { uri, domainName } = descriptor.strategy
    const prefix = [this.options.executable, '-c', uri] as const
    const domstate = await runProbe(
      this.probes,
      [...prefix, 'domstate', '--reason', domainName],
      this.options.probeCwd,
      signal,
    )
    recordHash(hashes, 'domstate', domstate)
    if (domstate.kind === 'error') {
      const reason = 'The libvirt domain-state probe could not run.'
      return inspectionUnavailable(target, reason, hashes)
    }
    if (!domstate.result.ok) {
      const failure = classifyDomainStateFailure(domstate.result)
      const inspectState: InspectionCapabilityState = failure.absent
        ? {
          status: 'supported',
          reason: 'The fixed libvirt inspection reached the daemon and reported that the domain is absent.',
          evidence: 'domstate: domain absent',
        }
        : {
          status: 'unavailable',
          reason: failure.reason,
          evidence: `domstate ${exitDescription(domstate.result)}`,
          hint: 'Verify the libvirt URI, driver availability, authentication, and socket permissions.',
        }
      return {
        reachability: failure.absent ? 'unreachable' : 'unknown',
        summary: failure.absent
          ? `Libvirt domain ${domainName} is absent.`
          : `Libvirt target ${target.displayName} could not be inspected: ${failure.reason}.`,
        outputHash: aggregateOutputHash(hashes),
        capabilities: capabilitiesForInspection(inspectState),
      }
    }

    const incomplete = new Set<string>()
    const state = parseDomainState(domstate.result.stdout)
    if (state.state === 'unknown') incomplete.add('domain state')

    const [dominfo, dumpxml, blockList, interfaceList, agentAddresses, snapshots] = await Promise.all([
      runProbe(this.probes, [...prefix, 'dominfo', domainName], this.options.probeCwd, signal),
      runProbe(this.probes, [...prefix, 'dumpxml', '--inactive', domainName], this.options.probeCwd, signal),
      runProbe(this.probes, [...prefix, 'domblklist', '--details', domainName], this.options.probeCwd, signal),
      runProbe(this.probes, [...prefix, 'domiflist', domainName], this.options.probeCwd, signal),
      runProbe(
        this.probes,
        [...prefix, 'domifaddr', '--source', 'agent', domainName],
        this.options.probeCwd,
        signal,
      ),
      runProbe(
        this.probes,
        [...prefix, 'snapshot-list', '--metadata', domainName],
        this.options.probeCwd,
        signal,
      ),
    ])
    recordHash(hashes, 'dominfo', dominfo)
    recordHash(hashes, 'dumpxml-inactive', dumpxml)
    recordHash(hashes, 'domblklist-details', blockList)
    recordHash(hashes, 'domiflist', interfaceList)
    recordHash(hashes, 'domifaddr-agent', agentAddresses)
    recordHash(hashes, 'snapshot-list-metadata', snapshots)

    const info = resultValue(dominfo)
    if (info === undefined) incomplete.add('domain information')
    const domainInfo = info === undefined ? new Map<string, string>() : parseKeyValueLines(info.stdout)

    let inactive: InactiveDomainFacts | undefined
    const xml = resultValue(dumpxml)
    if (xml === undefined) {
      incomplete.add('inactive XML')
    } else {
      try {
        inactive = parseInactiveDomainXml(
          xml.stdout,
          descriptor.strategy.expectedUuid,
          this.options.maxCollectionItems,
        )
        if (inactive.truncated) incomplete.add('inactive XML collection bound')
      } catch {
        incomplete.add('inactive XML')
      }
    }

    let blocks: ParsedRows<BlockRow> = { rows: [], truncated: false }
    const blockOutput = resultValue(blockList)
    if (blockOutput === undefined) {
      incomplete.add('block devices')
    } else {
      try {
        blocks = parseBlockList(blockOutput.stdout, this.options.maxCollectionItems)
        if (blocks.truncated) incomplete.add('block-device collection bound')
      } catch {
        incomplete.add('block devices')
      }
    }

    let interfaces: ParsedRows<InterfaceRow> = { rows: [], truncated: false }
    const interfaceOutput = resultValue(interfaceList)
    if (interfaceOutput === undefined) {
      incomplete.add('network interfaces')
    } else {
      try {
        interfaces = parseInterfaceList(interfaceOutput.stdout, this.options.maxCollectionItems)
        if (interfaces.truncated) incomplete.add('interface collection bound')
      } catch {
        incomplete.add('network interfaces')
      }
    }

    const addressFacts = await this.inspectAddresses(
      prefix,
      domainName,
      agentAddresses,
      hashes,
      signal,
    )
    if (addressFacts.addresses === undefined) incomplete.add('network addresses')
    if (addressFacts.truncated === true) incomplete.add('address collection bound')

    let snapshotCount: number | undefined
    const snapshotOutput = resultValue(snapshots)
    if (snapshotOutput === undefined) {
      incomplete.add('snapshot metadata')
    } else {
      try {
        const parsedSnapshots = parseSnapshotCount(snapshotOutput.stdout, this.options.maxCollectionItems)
        snapshotCount = parsedSnapshots.count
        if (parsedSnapshots.truncated) incomplete.add('snapshot collection bound')
      } catch {
        incomplete.add('snapshot metadata')
      }
    }

    const blockInfo = await this.inspectBlockInfo(prefix, domainName, blocks.rows, hashes, signal)
    if (blockInfo.size !== blocks.rows.length) incomplete.add('block details')

    const storage = await this.inspectStorage(
      prefix,
      inactive?.volumes ?? [],
      hashes,
      signal,
    )
    if (storage.inspected !== storage.expected) incomplete.add('managed storage')

    const vcpus = safeInteger(domainInfo.get('CPU(s)'))
    const memoryMiB = memoryToMiB(domainInfo.get('Max memory'))
    const observationInput: LibvirtObservationInput = {
      target,
      state,
      vcpus,
      memoryMiB,
      inactive,
      blocks,
      blockInfo,
      interfaces,
      addresses: addressFacts.addresses,
      addressSource: addressFacts.source,
      snapshotCount,
      storage,
      incomplete,
    }
    const summary = libvirtSummary(observationInput)
    const evidence = incomplete.size === 0
      ? `domstate=${state.state}; all fixed probes completed`
      : `domstate=${state.state}; partial=${[...incomplete].join(', ')}`

    return {
      reachability: 'reachable',
      summary,
      facts: libvirtFacts(observationInput),
      outputHash: aggregateOutputHash(hashes),
      capabilities: capabilitiesForInspection({
        status: 'supported',
        reason: incomplete.size === 0
          ? 'The fixed read-only libvirt inspection completed.'
          : 'The fixed read-only libvirt inspection completed with partial optional facts.',
        evidence,
      }),
    }
  }

  /** @inheritdoc */
  capabilities(
    target: StrategyTarget,
    prerequisites?: StrategyPrerequisites,
  ): readonly MachineCapability[] {
    if (target.descriptor?.strategy.kind !== this.kind) {
      return unavailableCapabilities('A declared libvirt URI and domain name are required.')
    }
    if (prerequisites?.available === false) {
      return unavailableCapabilities(
        prerequisites.reason,
        prerequisites.evidence,
        'Install and configure libvirt before using this capability through DSH tools.',
      )
    }
    return capabilitiesForInspection({
      status: 'deferred',
      reason: 'A fresh fixed libvirt inspection has not run.',
      hint: 'Refresh the machine inspection to query the declared domain.',
    })
  }

  private async inspectAddresses(
    prefix: readonly [string, string, string],
    domainName: string,
    agentAttempt: ProbeAttempt,
    hashes: LabeledHash[],
    signal?: AbortSignal,
  ): Promise<{
    readonly addresses?: readonly InterfaceAddress[]
    readonly source?: 'agent' | 'lease'
    readonly truncated?: boolean
  }> {
    const agent = parseAddressAttempt(agentAttempt, this.options.maxCollectionItems)
    if (agent !== undefined && agent.rows.length > 0) {
      return {
        addresses: agent.rows,
        source: 'agent',
        ...(agent.truncated ? { truncated: true } : {}),
      }
    }

    const leaseAttempt = await runProbe(
      this.probes,
      [...prefix, 'domifaddr', '--source', 'lease', domainName],
      this.options.probeCwd,
      signal,
    )
    recordHash(hashes, 'domifaddr-lease', leaseAttempt)
    const lease = parseAddressAttempt(leaseAttempt, this.options.maxCollectionItems)
    if (lease !== undefined && lease.rows.length > 0) {
      return {
        addresses: lease.rows,
        source: 'lease',
        ...(lease.truncated ? { truncated: true } : {}),
      }
    }
    return {}
  }

  private async inspectBlockInfo(
    prefix: readonly [string, string, string],
    domainName: string,
    blocks: readonly BlockRow[],
    hashes: LabeledHash[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, BlockInfo>> {
    const attempts = await Promise.all(blocks.map(async (block) => {
      const attempt = await runProbe(
        this.probes,
        [...prefix, 'domblkinfo', domainName, block.target],
        this.options.probeCwd,
        signal,
      )
      return { target: block.target, attempt }
    }))
    const inspected = new Map<string, BlockInfo>()
    for (const { target, attempt } of attempts) {
      recordHash(hashes, `domblkinfo:${target}`, attempt)
      const result = resultValue(attempt)
      if (result === undefined) continue
      const fields = parseKeyValueLines(result.stdout)
      if (fields.size === 0) continue
      const capacityBytes = safeInteger(fields.get('Capacity'))
      inspected.set(target, capacityBytes === undefined ? {} : { capacityBytes })
    }
    return inspected
  }

  private async inspectStorage(
    prefix: readonly [string, string, string],
    references: readonly StorageVolumeReference[],
    hashes: LabeledHash[],
    signal?: AbortSignal,
  ): Promise<{ readonly expected: number; readonly inspected: number }> {
    const pools = [...new Set(references.flatMap(reference => (
      reference.pool === undefined ? [] : [reference.pool]
    )))]
    const poolAttempts = await Promise.all(pools.map(async pool => ({
      pool,
      attempt: await runProbe(
        this.probes,
        [...prefix, 'pool-info', pool],
        this.options.probeCwd,
        signal,
      ),
    })))
    const volumeAttempts = await Promise.all(references.map(async reference => ({
      reference,
      attempt: await runProbe(
        this.probes,
        reference.pool === undefined
          ? [...prefix, 'vol-info', reference.volume]
          : [...prefix, 'vol-info', '--pool', reference.pool, reference.volume],
        this.options.probeCwd,
        signal,
      ),
    })))

    let inspected = 0
    for (const { pool, attempt } of poolAttempts) {
      recordHash(hashes, `pool-info:${pool}`, attempt)
      const result = resultValue(attempt)
      if (result !== undefined && parseKeyValueLines(result.stdout).size > 0) inspected++
    }
    for (const { reference, attempt } of volumeAttempts) {
      const label = reference.pool === undefined
        ? `vol-info:${reference.volume}`
        : `vol-info:${reference.pool}/${reference.volume}`
      recordHash(hashes, label, attempt)
      const result = resultValue(attempt)
      if (result !== undefined && parseKeyValueLines(result.stdout).size > 0) inspected++
    }
    return {
      expected: pools.length + references.length,
      inspected,
    }
  }
}

function capabilitiesForInspection(inspectState: InspectionCapabilityState): readonly MachineCapability[] {
  return MACHINE_CAPABILITY_NAMES.map((name): MachineCapability => {
    if (name === 'inspect') return { name, state: inspectState }
    if (name === 'metrics.read') {
      return {
        name,
        state: {
          status: 'deferred',
          reason: 'No metrics backend is configured.',
        },
      }
    }
    return {
      name,
      state: {
        status: 'unsupported',
        reason: 'The libvirt strategy is read-only and does not execute machine mutations.',
        hint: name === 'snapshot.live'
          ? 'Live snapshot support is not provided by the read-only strategy.'
          : 'Use DSH bash for a separately reviewed operation.',
      },
    }
  })
}

function unavailableCapabilities(
  reason: string,
  evidence?: string,
  hint = 'Provide a valid libvirt declaration and environment before retrying.',
): readonly MachineCapability[] {
  return MACHINE_CAPABILITY_NAMES.map(name => ({
    name,
    state: {
      status: 'unavailable',
      reason,
      ...(evidence === undefined ? {} : { evidence }),
      hint,
    },
  }))
}

function inspectionUnavailable(
  target: StrategyTarget,
  reason: string,
  hashes: readonly LabeledHash[],
): StrategyInspection {
  return {
    reachability: 'unknown',
    summary: `Libvirt target ${target.displayName} could not be inspected: ${reason}`,
    ...(hashes.length === 0 ? {} : { outputHash: aggregateOutputHash(hashes) }),
    capabilities: unavailableCapabilities(reason),
  }
}

async function runProbe(
  probes: ReadOnlyProbeRunner,
  argv: readonly [string, ...string[]],
  cwd: string,
  signal?: AbortSignal,
): Promise<ProbeAttempt> {
  try {
    return { kind: 'result', result: await probes.run(argv, cwd, signal) }
  } catch {
    signal?.throwIfAborted()
    return { kind: 'error' }
  }
}

function resultValue(attempt: ProbeAttempt): ProbeResult | undefined {
  return attempt.kind === 'result' && attempt.result.ok ? attempt.result : undefined
}

function recordHash(hashes: LabeledHash[], label: string, attempt: ProbeAttempt): void {
  if (attempt.kind === 'result') hashes.push({ label, hash: attempt.result.outputHash })
}

function aggregateOutputHash(hashes: readonly LabeledHash[]): string {
  return aggregateProbeOutputHash('dsh-machine-libvirt-inspect/v1', hashes)
}

function classifyDomainStateFailure(result: ProbeResult): { readonly absent: boolean; readonly reason: string } {
  const diagnostic = `${result.stdout}\n${result.stderr}`.toLocaleLowerCase()
  if (
    diagnostic.includes('failed to get domain')
    || diagnostic.includes('domain not found')
    || diagnostic.includes('no domain with matching')
  ) {
    return { absent: true, reason: 'The declared libvirt domain does not exist.' }
  }
  if (diagnostic.includes('permission denied') || diagnostic.includes('authentication failed')) {
    return { absent: false, reason: 'Libvirt denied access to the declared connection.' }
  }
  if (
    diagnostic.includes('failed to connect')
    || diagnostic.includes('no connection driver')
    || diagnostic.includes('unsupported')
  ) {
    return { absent: false, reason: 'The declared libvirt connection or driver is unavailable.' }
  }
  return {
    absent: false,
    reason: `The libvirt domain-state probe failed (${exitDescription(result)})`,
  }
}

function parseDomainState(output: string): DomainState {
  const line = output.split(/\r?\n/u).map(value => value.trim()).find(value => value !== '') ?? ''
  const match = /^(.*?)(?:\s+\(([^()]*)\))?$/u.exec(line)
  const candidate = match?.[1]?.trim().toLocaleLowerCase() ?? ''
  const state = LIBVIRT_STATES.has(candidate) ? candidate : 'unknown'
  const reason = match?.[2]?.trim().toLocaleLowerCase()
  return {
    state,
    ...(reason === undefined || !/^[a-z0-9 _-]{1,80}$/u.test(reason) ? {} : { reason }),
  }
}

function parseInactiveDomainXml(
  output: string,
  expectedUuid: string | undefined,
  limit: number,
): InactiveDomainFacts {
  const parsed: unknown = XML_PARSER.parse(output, true)
  const domain = objectField(asRecord(parsed), 'domain')
  if (domain === undefined) throw new Error('inactive XML has no domain element')
  const devices = objectField(domain, 'devices')
  const disks = nodeArray(devices?.disk)
  const interfaces = nodeArray(devices?.interface)
  const volumeByKey = new Map<string, StorageVolumeReference>()
  let truncated = disks.length > limit || interfaces.length > limit
  for (const diskValue of disks.slice(0, limit)) {
    const disk = asRecord(diskValue)
    const source = objectField(disk, 'source')
    const pool = attribute(source, 'pool')
    const volume = attribute(source, 'volume')
    const path = attribute(source, 'file') ?? attribute(source, 'dev')
    if (pool !== undefined && volume !== undefined) {
      if (!safeVirshOperand(pool) || !safeVirshOperand(volume)) {
        truncated = true
        continue
      }
      if (volumeByKey.size >= limit) {
        truncated = true
        break
      }
      volumeByKey.set(`managed\0${pool}\0${volume}`, { pool, volume })
      continue
    }
    if (path === undefined) continue
    if (!safeVirshOperand(path)) {
      truncated = true
      continue
    }
    if (volumeByKey.size >= limit) {
      truncated = true
      break
    }
    volumeByKey.set(`path\0${path}`, { volume: path })
  }
  const uuid = textValue(domain.uuid)
  return {
    diskCount: disks.length,
    interfaceCount: interfaces.length,
    ...(expectedUuid === undefined || uuid === undefined
      ? {}
      : { expectedUuidMatches: uuid.toLocaleLowerCase() === expectedUuid.toLocaleLowerCase() }),
    volumes: [...volumeByKey.values()],
    truncated,
  }
}

function parseBlockList(output: string, limit: number): ParsedRows<BlockRow> {
  const body = tableBody(output, ['type', 'device', 'target', 'source'])
  const rows: BlockRow[] = []
  for (const line of body) {
    const match = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/u.exec(line)
    if (match === null) throw new Error('invalid domblklist row')
    const target = match[3] ?? ''
    if (!safeVirshOperand(target)) throw new Error('unsafe domblklist target')
    if (rows.length < limit) {
      rows.push({
        type: match[1] ?? '',
        device: match[2] ?? '',
        target,
        source: match[4] ?? '',
      })
    }
  }
  return { rows, truncated: body.length > limit }
}

function parseInterfaceList(output: string, limit: number): ParsedRows<InterfaceRow> {
  const body = tableBody(output, ['interface', 'type', 'source', 'model', 'mac'])
  const rows: InterfaceRow[] = []
  for (const line of body) {
    const match = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/u.exec(line)
    if (match === null) throw new Error('invalid domiflist row')
    if (rows.length < limit) {
      rows.push({
        name: match[1] ?? '',
        type: match[2] ?? '',
        source: match[3] ?? '',
        model: match[4] ?? '',
        mac: match[5] ?? '',
      })
    }
  }
  return { rows, truncated: body.length > limit }
}

function parseAddressAttempt(
  attempt: ProbeAttempt,
  limit: number,
): ParsedRows<InterfaceAddress> | undefined {
  const result = resultValue(attempt)
  if (result === undefined) return undefined
  try {
    return parseInterfaceAddresses(result.stdout, limit)
  } catch {
    return undefined
  }
}

function parseInterfaceAddresses(output: string, limit: number): ParsedRows<InterfaceAddress> {
  const body = tableBody(output, ['name', 'mac', 'address', 'protocol', 'address'])
  const rows: InterfaceAddress[] = []
  for (const line of body) {
    const match = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/u.exec(line)
    if (match === null) throw new Error('invalid domifaddr row')
    const protocol = match[3]?.toLocaleLowerCase() ?? ''
    const address = match[4] ?? ''
    if ((protocol !== 'ipv4' && protocol !== 'ipv6') || !/^[0-9a-f.:]+\/[0-9]{1,3}$/iu.test(address)) {
      continue
    }
    if (rows.length < limit) rows.push({ protocol, address })
  }
  return { rows, truncated: body.length > limit }
}

function parseSnapshotCount(
  output: string,
  limit: number,
): { readonly count: number; readonly truncated: boolean } {
  const body = tableBody(output, ['name', 'creation', 'time', 'state'])
  return { count: Math.min(body.length, limit), truncated: body.length > limit }
}

function tableBody(output: string, expectedHeaderTokens: readonly string[]): readonly string[] {
  const lines = output.split(/\r?\n/u)
  const separator = lines.findIndex(line => /^\s*-{3,}\s*$/u.test(line))
  if (separator < 1) throw new Error('virsh table separator is missing')
  const header = lines.slice(0, separator).reverse().find(line => line.trim() !== '')?.toLocaleLowerCase() ?? ''
  const headerTokens = header.split(/\s+/u).filter(Boolean)
  if (!isOrderedSubsequence(expectedHeaderTokens, headerTokens)) {
    throw new Error('virsh table header is not recognized')
  }
  return lines.slice(separator + 1).filter(line => line.trim() !== '')
}

function isOrderedSubsequence(expected: readonly string[], actual: readonly string[]): boolean {
  let cursor = 0
  for (const value of actual) {
    if (value === expected[cursor]) cursor++
  }
  return cursor === expected.length
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function objectField(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  return asRecord(value?.[key])
}

function nodeArray(value: unknown): readonly unknown[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function attribute(value: Readonly<Record<string, unknown>> | undefined, name: string): string | undefined {
  return stringValue(value?.[`@_${name}`])
}

function textValue(value: unknown): string | undefined {
  const direct = stringValue(value)
  if (direct !== undefined) return direct
  return stringValue(asRecord(value)?.['#text'])
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function safeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function memoryToMiB(value: string | undefined): number | undefined {
  const match = /^([0-9]+)\s+(KiB|MiB|GiB)$/u.exec(value ?? '')
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount)) return undefined
  switch (match[2]) {
    case 'KiB': return Math.round(amount / 1024)
    case 'MiB': return amount
    case 'GiB': return amount * 1024
    default: return undefined
  }
}

interface LibvirtObservationInput {
  readonly target: StrategyTarget
  readonly state: DomainState
  readonly vcpus?: number | undefined
  readonly memoryMiB?: number | undefined
  readonly inactive?: InactiveDomainFacts | undefined
  readonly blocks: ParsedRows<BlockRow>
  readonly blockInfo: ReadonlyMap<string, BlockInfo>
  readonly interfaces: ParsedRows<InterfaceRow>
  readonly addresses?: readonly InterfaceAddress[] | undefined
  readonly addressSource?: 'agent' | 'lease' | undefined
  readonly snapshotCount?: number | undefined
  readonly storage: { readonly expected: number; readonly inspected: number }
  readonly incomplete: ReadonlySet<string>
}

function libvirtSummary(input: LibvirtObservationInput): string {
  const facts = [
    `state=${input.state.state}${input.state.reason === undefined ? '' : ` (${input.state.reason})`}`,
    `vcpus=${input.vcpus === undefined ? 'unknown' : String(input.vcpus)}`,
    `memoryMiB=${input.memoryMiB === undefined ? 'unknown' : String(input.memoryMiB)}`,
    `inactiveDisks=${input.inactive === undefined ? 'unknown' : String(input.inactive.diskCount)}`,
    `blockDevices=${input.blocks.rows.length}`,
    `blockDetails=${input.blockInfo.size}/${input.blocks.rows.length}`,
    `inactiveInterfaces=${input.inactive === undefined ? 'unknown' : String(input.inactive.interfaceCount)}`,
    `interfaces=${input.interfaces.rows.length}`,
    `addresses=${input.addresses === undefined ? 'unknown' : input.addresses.map(value => value.address).join(',')}`,
    `addressSource=${input.addressSource ?? 'unknown'}`,
    `snapshots=${input.snapshotCount === undefined ? 'unknown' : String(input.snapshotCount)}`,
    `managedStorage=${input.storage.inspected}/${input.storage.expected}`,
  ]
  if (input.inactive?.expectedUuidMatches !== undefined) {
    facts.push(`expectedUuidMatches=${String(input.inactive.expectedUuidMatches)}`)
  }
  facts.push(input.incomplete.size === 0
    ? 'observation=complete'
    : `observation=partial (${[...input.incomplete].join(', ')})`)
  return `Libvirt target ${input.target.displayName}: ${facts.join('; ')}.`
}

function libvirtFacts(input: LibvirtObservationInput): readonly MachineFact[] {
  const addresses = input.addresses === undefined
    ? '未发现地址'
    : addressFact(input.addresses)
  return [
    {
      label: '状态',
      value: `${input.state.state}${input.state.reason === undefined ? '' : ` (${input.state.reason})`}`,
    },
    {
      label: 'CPU',
      value: input.vcpus === undefined ? '未知' : `${String(input.vcpus)} vCPU`,
    },
    {
      label: '内存',
      value: input.memoryMiB === undefined ? '未知' : `${String(input.memoryMiB)} MiB`,
    },
    {
      label: '磁盘',
      value: diskFact(input),
    },
    {
      label: '网卡',
      value: interfaceFact(input),
    },
    { label: '地址', value: addresses },
    {
      label: '快照',
      value: input.snapshotCount === undefined
        ? '未知'
        : input.snapshotCount === 0
          ? '无快照'
          : `${String(input.snapshotCount)} 个`,
    },
  ]
}

function addressFact(addresses: readonly InterfaceAddress[]): string {
  return boundedFactItems(addresses.map(address => address.address))
}

function diskFact(input: LibvirtObservationInput): string {
  if (input.blocks.rows.length === 0) return '无磁盘'
  const items = input.blocks.rows.map((block) => {
    const capacityBytes = input.blockInfo.get(block.target)?.capacityBytes
    const capacity = capacityBytes === undefined ? '大小未知' : formatCapacity(capacityBytes)
    return `${compactText(block.target, 24)} ${capacity}`
  })
  const result = boundedFactItems(items)
  if (!input.blocks.truncated && !input.incomplete.has('block devices')) return result
  return `${result}${input.blocks.truncated ? ' · 列表已截断' : ''}${input.incomplete.has('block devices') ? ' · 数据不完整' : ''}`
}

function interfaceFact(input: LibvirtObservationInput): string {
  if (input.interfaces.rows.length === 0) return '无网卡'
  const items = input.interfaces.rows.map((row) => {
    const name = row.name === '-' ? '未命名' : compactText(row.name, 24)
    const mac = row.mac === '-' ? '' : compactText(row.mac, 32)
    return `${name} ${mac}`.trimEnd()
  })
  const result = boundedFactItems(items)
  if (!input.interfaces.truncated && !input.incomplete.has('network interfaces')) return result
  return `${result}${input.interfaces.truncated ? ' · 列表已截断' : ''}${input.incomplete.has('network interfaces') ? ' · 数据不完整' : ''}`
}

function formatCapacity(bytes: number): string {
  const units = [
    { size: 1024 ** 4, label: 'TiB' },
    { size: 1024 ** 3, label: 'GiB' },
    { size: 1024 ** 2, label: 'MiB' },
    { size: 1024, label: 'KiB' },
  ] as const
  for (const unit of units) {
    if (bytes < unit.size) continue
    const value = bytes / unit.size
    return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${unit.label}`
  }
  return `${String(bytes)} B`
}

function boundedFactItems(
  items: readonly string[],
  maxCharacters = MAX_FACT_VALUE_CHARACTERS,
): string {
  const selected: string[] = []
  for (const item of items) {
    const candidate = [...selected, item].join(' · ')
    const remaining = items.length - selected.length - 1
    const suffix = remaining === 0 ? '' : ` · 另有 ${String(remaining)} 项`
    if (candidate.length + suffix.length > maxCharacters && selected.length > 0) break
    selected.push(item)
  }
  const remaining = items.length - selected.length
  return `${selected.join(' · ')}${remaining === 0 ? '' : ` · 另有 ${String(remaining)} 项`}`
}

function compactText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`
}

function virshVersionEvidence(output: string): string | undefined {
  const match = /(?:^|\s)([0-9]+\.[0-9]+(?:\.[0-9]+)?)(?:\s|$)/u.exec(output)
  return match?.[1] === undefined ? undefined : `virsh ${match[1]}`
}

function exitDescription(result: Pick<ProbeResult, 'exitCode' | 'signal'>): string {
  return result.signal === null
    ? `exit code ${String(result.exitCode)}`
    : `signal ${result.signal}`
}
