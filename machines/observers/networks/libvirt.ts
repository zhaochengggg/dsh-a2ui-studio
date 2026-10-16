/**
 * Bounded host-level observation of libvirt virtual networks.
 *
 * @module dsh-control-studio/machines/networks/libvirt
 */

import { isIP } from 'node:net'
import { XMLParser } from 'fast-xml-parser'
import type {
  LibvirtNetworkAddress,
  LibvirtNetworkCapability,
  LibvirtNetworkDhcpRange,
  LibvirtNetworkDiagnostic,
  LibvirtNetworkObservation,
  LibvirtNetworkSummary,
} from '../types.ts'
import {
  aggregateOutputHash,
  parseKeyValueLines,
  safeVirshOperand,
  type LabeledOutputHash,
} from '../strategies/libvirt-readonly.ts'
import type { ProbeResult, ReadOnlyProbeRunner } from '../strategies/runner.ts'

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
})

interface NetworkListRow {
  readonly name: string
  readonly active: boolean
  readonly persistent: boolean
  readonly autostart: boolean
}

interface ParsedNetworkList {
  readonly rows: readonly NetworkListRow[]
  readonly truncated: boolean
}

interface ParsedNetworkXml {
  readonly bridge?: string | undefined
  readonly forwardMode?: string | undefined
  readonly addresses: readonly LibvirtNetworkAddress[]
  readonly dhcpEnabled: boolean
  readonly dhcpRanges: readonly LibvirtNetworkDhcpRange[]
  readonly connections?: number | undefined
  readonly truncated: boolean
}

type ProbeAttempt =
  | { readonly kind: 'result'; readonly result: ProbeResult }
  | { readonly kind: 'error' }

/** Deployment-owned libvirt connection and collection bounds. */
export interface LibvirtNetworkObserverOptions {
  readonly executable: string
  readonly uri: string
  readonly probeCwd: string
  readonly maxCollectionItems: number
}

/** Host-level observer that exposes no libvirt mutation operation. */
export class LibvirtNetworkObserver {
  /**
   * @param probes - bounded DSH subprocess runner.
   * @param options - executable, connection, working directory, and collection bound.
   */
  constructor(
    private readonly probes: ReadOnlyProbeRunner,
    private readonly options: LibvirtNetworkObserverOptions,
  ) {}

  /**
   * List host libvirt networks through fixed `net-list`, `net-info`, and `net-dumpxml` queries.
   * @param signal - caller cancellation.
   * @returns bounded network facts, diagnostics, capability state, and aggregate output digest.
   */
  async observe(signal?: AbortSignal): Promise<LibvirtNetworkObservation> {
    const hashes: LabeledOutputHash[] = []
    const listAttempt = await runProbe(
      this.probes,
      [this.options.executable, '-c', this.options.uri, 'net-list', '--all'],
      this.options.probeCwd,
      signal,
    )
    recordHash(hashes, 'net-list-all', listAttempt)
    if (listAttempt.kind === 'error') {
      return unavailableObservation(
        Date.now(),
        'The libvirt network-list probe could not run.',
        [{ code: 'probe-unavailable', message: 'The fixed net-list probe could not run.' }],
        hashes,
      )
    }
    if (!listAttempt.result.ok) {
      return unavailableObservation(
        Date.now(),
        'The libvirt connection could not list host networks.',
        [{ code: 'net-list-failed', message: 'The fixed net-list probe failed.' }],
        hashes,
      )
    }

    let listed: ParsedNetworkList
    try {
      listed = parseNetworkList(listAttempt.result.stdout, this.options.maxCollectionItems)
    } catch {
      return unavailableObservation(
        Date.now(),
        'The libvirt network list was not valid bounded virsh output.',
        [{ code: 'net-list-invalid', message: 'The net-list output could not be parsed safely.' }],
        hashes,
      )
    }

    const diagnostics: LibvirtNetworkDiagnostic[] = []
    if (listed.truncated) {
      diagnostics.push({
        code: 'network-list-truncated',
        message: `Host networks exceed the configured collection limit of ${this.options.maxCollectionItems}.`,
      })
    }
    const networks: LibvirtNetworkSummary[] = []
    for (const row of listed.rows) {
      const [infoAttempt, xmlAttempt] = await Promise.all([
        runProbe(
          this.probes,
          [this.options.executable, '-c', this.options.uri, 'net-info', row.name],
          this.options.probeCwd,
          signal,
        ),
        runProbe(
          this.probes,
          [this.options.executable, '-c', this.options.uri, 'net-dumpxml', row.name],
          this.options.probeCwd,
          signal,
        ),
      ])
      recordHash(hashes, `net-info:${row.name}`, infoAttempt)
      recordHash(hashes, `net-dumpxml:${row.name}`, xmlAttempt)

      let infoBridge: string | undefined
      const info = successfulResult(infoAttempt)
      if (info === undefined) {
        diagnostics.push({
          code: 'net-info-failed',
          network: row.name,
          message: 'The fixed net-info probe did not return network details.',
        })
      } else {
        try {
          infoBridge = parseNetworkInfo(info.stdout, row.name).bridge
        } catch {
          diagnostics.push({
            code: 'net-info-invalid',
            network: row.name,
            message: 'The net-info output could not be parsed safely.',
          })
        }
      }

      let details: ParsedNetworkXml | undefined
      const xml = successfulResult(xmlAttempt)
      if (xml === undefined) {
        diagnostics.push({
          code: 'net-dumpxml-failed',
          network: row.name,
          message: 'The fixed net-dumpxml probe did not return network XML.',
        })
      } else {
        try {
          details = parseNetworkXml(xml.stdout, row.name, this.options.maxCollectionItems)
          if (details.truncated) {
            diagnostics.push({
              code: 'network-details-truncated',
              network: row.name,
              message: `Network addresses or DHCP ranges exceed the configured collection limit of ${this.options.maxCollectionItems}.`,
            })
          }
        } catch {
          diagnostics.push({
            code: 'net-dumpxml-invalid',
            network: row.name,
            message: 'The net-dumpxml output could not be parsed safely.',
          })
        }
      }

      networks.push({
        name: row.name,
        active: row.active,
        persistent: row.persistent,
        autostart: row.autostart,
        ...(details?.bridge === undefined && infoBridge === undefined
          ? {}
          : { bridge: details?.bridge ?? infoBridge }),
        ...(details?.forwardMode === undefined ? {} : { forwardMode: details.forwardMode }),
        ...(details === undefined
          ? {}
          : {
            addresses: details.addresses,
            dhcpEnabled: details.dhcpEnabled,
            dhcpRanges: details.dhcpRanges,
          }),
        ...(details?.connections === undefined ? {} : { connections: details.connections }),
      })
    }

    const partial = diagnostics.length > 0
    return {
      observedAt: Date.now(),
      capability: supportedCapability(networks.length, partial),
      networks,
      diagnostics,
      outputHash: aggregateOutputHash('dsh-machine-libvirt-network-observe/v1', hashes),
    }
  }
}

/**
 * Parse bounded `virsh net-list --all` output and reject unsafe names before reuse as operands.
 * @param output - bounded net-list stdout.
 * @param limit - maximum returned networks.
 * @returns stable rows and truncation state.
 */
export function parseNetworkList(output: string, limit: number): ParsedNetworkList {
  const body = tableBody(output, ['name', 'state', 'autostart', 'persistent'])
  const rows: NetworkListRow[] = []
  for (const line of body) {
    const match = /^\s*(.*?)\s+(active|inactive)\s+(yes|no)\s+(yes|no)\s*$/u.exec(line)
    if (match === null) throw new Error('invalid net-list row')
    const name = match[1] ?? ''
    if (!safeVirshOperand(name)) throw new Error('unsafe net-list network name')
    if (rows.length < limit) {
      rows.push({
        name,
        active: match[2] === 'active',
        autostart: match[3] === 'yes',
        persistent: match[4] === 'yes',
      })
    }
  }
  return { rows, truncated: body.length > limit }
}

/**
 * Parse one bounded `virsh net-info` response and verify its identity.
 * @param output - bounded net-info stdout.
 * @param expectedName - network operand used for the query.
 * @returns optional bridge name.
 */
export function parseNetworkInfo(
  output: string,
  expectedName: string,
): { readonly bridge?: string | undefined } {
  const fields = parseKeyValueLines(output)
  if (fields.get('Name') !== expectedName) throw new Error('net-info name mismatch')
  const bridge = fields.get('Bridge')
  if (bridge === undefined || bridge === '-') return {}
  if (!safeDisplayValue(bridge)) throw new Error('unsafe net-info bridge')
  return { bridge }
}

/**
 * Structurally parse bounded libvirt network XML without resolving entities.
 * @param output - bounded net-dumpxml stdout.
 * @param expectedName - network operand used for the query.
 * @param limit - maximum addresses and DHCP ranges retained.
 * @returns normalized network details.
 */
export function parseNetworkXml(
  output: string,
  expectedName: string,
  limit: number,
): ParsedNetworkXml {
  const parsed: unknown = XML_PARSER.parse(output, true)
  const network = objectField(asRecord(parsed), 'network')
  if (network === undefined) throw new Error('network XML has no network element')
  if (textValue(network.name) !== expectedName) throw new Error('network XML name mismatch')

  const forwardMode = validatedAttribute(objectField(network, 'forward'), 'mode')
  const bridge = validatedAttribute(objectField(network, 'bridge'), 'name')
  const connections = nonNegativeInteger(attribute(network, 'connections'))
  const addresses: LibvirtNetworkAddress[] = []
  const dhcpRanges: LibvirtNetworkDhcpRange[] = []
  let dhcpEnabled = false
  let truncated = false

  for (const ipValue of nodeArray(network.ip)) {
    const ip = asRecord(ipValue)
    const address = attribute(ip, 'address')
    const family = attribute(ip, 'family') === 'ipv6' ? 'ipv6' : 'ipv4'
    if (address === undefined || !validIpAddress(address, family)) continue
    const prefix = networkPrefix(ip, family)
    if (addresses.length < limit) {
      addresses.push({
        family,
        address,
        ...(prefix === undefined ? {} : { prefix }),
        ...(family !== 'ipv4' || prefix === undefined
          ? {}
          : { network: ipv4Network(address, prefix) }),
      })
    } else {
      truncated = true
    }

    const dhcp = objectField(ip, 'dhcp')
    if (dhcp === undefined) continue
    dhcpEnabled = true
    for (const rangeValue of nodeArray(dhcp.range)) {
      const range = asRecord(rangeValue)
      const start = attribute(range, 'start')
      const end = attribute(range, 'end')
      if (
        start === undefined
        || end === undefined
        || !validIpAddress(start, family)
        || !validIpAddress(end, family)
      ) {
        continue
      }
      if (dhcpRanges.length < limit) dhcpRanges.push({ family, start, end })
      else truncated = true
    }
  }

  return {
    ...(bridge === undefined ? {} : { bridge }),
    ...(forwardMode === undefined ? {} : { forwardMode }),
    addresses,
    dhcpEnabled,
    dhcpRanges,
    ...(connections === undefined ? {} : { connections }),
    truncated,
  }
}

function supportedCapability(count: number, partial: boolean): LibvirtNetworkCapability {
  return {
    name: 'libvirt.network.read',
    state: {
      status: 'supported',
      reason: partial
        ? 'Fixed read-only libvirt network observation completed with partial details.'
        : 'Fixed read-only libvirt network observation completed.',
      evidence: `${count} host network${count === 1 ? '' : 's'} observed`,
    },
  }
}

function unavailableObservation(
  observedAt: number,
  reason: string,
  diagnostics: readonly LibvirtNetworkDiagnostic[],
  hashes: readonly LabeledOutputHash[],
): LibvirtNetworkObservation {
  return {
    observedAt,
    capability: {
      name: 'libvirt.network.read',
      state: {
        status: 'unavailable',
        reason,
        hint: 'Verify the configured libvirt URI, driver availability, authentication, and socket permissions.',
      },
    },
    networks: [],
    diagnostics,
    ...(hashes.length === 0
      ? {}
      : { outputHash: aggregateOutputHash('dsh-machine-libvirt-network-observe/v1', hashes) }),
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

function successfulResult(attempt: ProbeAttempt): ProbeResult | undefined {
  return attempt.kind === 'result' && attempt.result.ok ? attempt.result : undefined
}

function recordHash(
  hashes: LabeledOutputHash[],
  label: string,
  attempt: ProbeAttempt,
): void {
  if (attempt.kind === 'result') hashes.push({ label, hash: attempt.result.outputHash })
}

function tableBody(output: string, expectedHeaderTokens: readonly string[]): readonly string[] {
  const lines = output.split(/\r?\n/u)
  const separator = lines.findIndex(line => /^\s*-{3,}\s*$/u.test(line))
  if (separator < 1) throw new Error('virsh table separator is missing')
  const header = lines.slice(0, separator).reverse().find(line => line.trim() !== '')?.toLocaleLowerCase() ?? ''
  const headerTokens = header.split(/\s+/u).filter(Boolean)
  let cursor = 0
  for (const value of headerTokens) {
    if (value === expectedHeaderTokens[cursor]) cursor++
  }
  if (cursor !== expectedHeaderTokens.length) throw new Error('virsh table header is not recognized')
  return lines.slice(separator + 1).filter(line => line.trim() !== '')
}

function networkPrefix(
  ip: Readonly<Record<string, unknown>> | undefined,
  family: 'ipv4' | 'ipv6',
): number | undefined {
  const maximum = family === 'ipv4' ? 32 : 128
  const explicit = nonNegativeInteger(attribute(ip, 'prefix'))
  if (explicit !== undefined) return explicit <= maximum ? explicit : undefined
  if (family === 'ipv6') return undefined
  return ipv4NetmaskPrefix(attribute(ip, 'netmask'))
}

function ipv4NetmaskPrefix(netmask: string | undefined): number | undefined {
  const bytes = parseIpv4(netmask)
  if (bytes === undefined) return undefined
  const bits = bytes.map(value => value.toString(2).padStart(8, '0')).join('')
  if (!/^1*0*$/u.test(bits)) return undefined
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0')
}

function ipv4Network(address: string, prefix: number): string {
  const bytes = parseIpv4(address)
  if (bytes === undefined) throw new Error('invalid IPv4 address')
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0
  const value = (
    ((bytes[0] ?? 0) << 24)
    | ((bytes[1] ?? 0) << 16)
    | ((bytes[2] ?? 0) << 8)
    | (bytes[3] ?? 0)
  ) >>> 0
  const network = (value & mask) >>> 0
  return [
    (network >>> 24) & 0xff,
    (network >>> 16) & 0xff,
    (network >>> 8) & 0xff,
    network & 0xff,
  ].join('.') + `/${prefix}`
}

function validIpAddress(value: string, family: 'ipv4' | 'ipv6'): boolean {
  return isIP(value) === (family === 'ipv4' ? 4 : 6)
}

function parseIpv4(value: string | undefined): readonly number[] | undefined {
  if (value === undefined) return undefined
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const bytes = parts.map((part) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return undefined
    const parsed = Number(part)
    return parsed <= 255 ? parsed : undefined
  })
  return bytes.every(byte => byte !== undefined) ? bytes : undefined
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function safeDisplayValue(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validatedAttribute(
  value: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string | undefined {
  const candidate = attribute(value, name)
  if (candidate === undefined) return undefined
  if (!safeDisplayValue(candidate)) throw new Error(`unsafe XML ${name} attribute`)
  return candidate
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

function attribute(
  value: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string | undefined {
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
