import { z } from 'zod'
import { componentTypes } from '../src/engine/registry.js'

/**
 * Shared validation schema.
 *
 * The **same** Zod schema guards both sides of the wire:
 *   * the client validates a payload before POSTing it (instant feedback), and
 *   * the Express API validates the exact same object on arrival (zero trust).
 *
 * Importing the engine's component registry on the server means a payload can
 * never name a component class that does not exist — the enum *is* the registry.
 */

/** Hard limits — a malformed or hostile payload cannot exhaust the server. */
export const LIMITS = {
  /** Upper bound on stored water fills per scene. */
  maxFills: 32,
  maxNodes: 500,
  maxEdges: 1500,
  maxParticles: 600,
  maxPayloadBytes: 2 * 1024 * 1024,
  maxCoordinate: 100000,
  maxPropertiesPerNode: 64,
  maxRules: 32,
  maxStringLength: 400,
}

const COORD = z
  .number()
  .finite()
  .min(-LIMITS.maxCoordinate)
  .max(LIMITS.maxCoordinate)

/** Properties are an open record, but values must be JSON primitives. */
const primitive = z.union([z.string().max(LIMITS.maxStringLength), z.number().finite(), z.boolean(), z.null()])

/** Rule tables are the one structured property: validated in full detail. */
const smallRecord = z
  .record(z.string().max(48), primitive)
  .refine((record) => Object.keys(record).length <= 32, { message: 'nested object too large' })

const ruleSchema = z
  .object({
    id: z.string().min(1).max(64),
    source: z.enum(['in0', 'in1', 'in2', 'in3']),
    target: z.enum(['out0', 'out1', 'out2', 'out3']),
    mode: z.enum(['above', 'below', 'window', 'toggle', 'always']),
    threshold: z.number().finite().min(-1e6).max(1e6).optional(),
    /** Compare against another analog pin instead of a constant (setpoint dial). */
    thresholdPin: z.enum(['in0', 'in1', 'in2', 'in3']).optional(),
    /** How this rule merges with other rules driving the same output pin. */
    combine: z.enum(['or', 'and']).optional(),
    hysteresis: z.number().finite().min(0).max(1e5).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    debounceMs: z.number().finite().min(0).max(10000).optional(),
    invert: z.boolean().optional(),
    label: z.string().max(120).optional(),
  })
  .strict()

/** Every property must be a JSON primitive, a rule table or a small record. */
const propertyValue = z.union([
  primitive,
  z.array(ruleSchema).max(LIMITS.maxRules),
  z.array(primitive).max(200),
  smallRecord,
])

export const nodeSchema = z
  .object({
    id: z.string().min(1).max(120),
    type: z.enum(componentTypes),
    x: COORD,
    y: COORD,
    rotation: z.number().finite().min(-100).max(100).optional(),
    properties: z
      .record(z.string().max(64), propertyValue)
      .refine((record) => Object.keys(record).length <= LIMITS.maxPropertiesPerNode, {
        message: `at most ${LIMITS.maxPropertiesPerNode} properties per node`,
      })
      .optional(),
    state: z.record(z.string().max(64), z.unknown()).optional(),
    connections: z
      .record(
        z.string().max(64),
        z.union([
          z.object({ node: z.string().min(1).max(120), port: z.string().max(64).optional() }),
          z.string().min(1).max(120),
          z.array(z.union([
            z.object({ node: z.string().min(1).max(120), port: z.string().max(64).optional() }),
            z.string().min(1).max(120),
          ])).max(16),
        ]),
      )
      .optional(),
  })
  

export const edgeSchema = z
  .object({
    id: z.string().min(1).max(120),
    from: z.object({ node: z.string().min(1).max(120), port: z.string().min(1).max(64) }),
    to: z.object({ node: z.string().min(1).max(120), port: z.string().min(1).max(64) }),
    kind: z.enum(['digital', 'analog', 'text']).optional(),
  })
  .strict()

export const environmentSchema = z
  .object({
    gravity: z.number().finite().min(-20000).max(20000).default(981),
    gravityMetersPerSecondSquared: z.number().finite().min(-200).max(200).optional(),
    pixelsPerMetre: z.number().finite().positive().max(10000).optional(),
    timestep: z.number().finite().min(1 / 480).max(1 / 10).default(1 / 60),
    bounds: z
      .object({
        width: z.number().finite().min(200).max(20000).default(1600),
        height: z.number().finite().min(200).max(20000).default(900),
      })
      
      .optional(),
  })
  

/**
 * One "pour": a rectangular block of water the scene starts with.
 *
 * The wire format stores fills rather than individual particles, which keeps a
 * 260-droplet scene at ~40 bytes of water instead of ~260 coordinate pairs — and
 * it is what a reset replays to restore the initial condition exactly.
 */
export const fillSchema = z.object({
  x: COORD,
  y: COORD,
  count: z.number().int().min(0).max(LIMITS.maxParticles),
  spreadX: z.number().finite().min(0).max(LIMITS.maxCoordinate).default(90),
  spreadY: z.number().finite().min(0).max(LIMITS.maxCoordinate).default(60),
})

export const fluidSchema = z.union([
  z.array(fillSchema).max(LIMITS.maxFills),
  // v1/v2 payloads serialized the raw particle list; still accepted on import.
  z.object({
    seed: z.number().int().finite().optional(),
    maxParticles: z.number().int().min(0).max(LIMITS.maxParticles).default(260),
    radius: z.number().finite().min(1).max(40).default(5),
    particles: z
      .array(z.tuple([COORD, COORD]))
      .max(LIMITS.maxParticles)
      .default([]),
  }),
])
  

export const projectPayloadSchema = z
  .object({
    formatVersion: z.number().int().min(1).max(100).optional(),
    simulationId: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9_-]+$/, 'simulationId must be URL-safe')
      .optional(),
    name: z.string().min(1).max(120).default('Untitled Simulation'),
    description: z.string().max(600).optional(),
    author: z.string().max(80).optional(),
    createdAt: z.string().max(40).optional(),
    updatedAt: z.string().max(40).optional(),
    environment: environmentSchema.optional(),
    nodes: z.array(nodeSchema).min(1).max(LIMITS.maxNodes),
    edges: z.array(edgeSchema).max(LIMITS.maxEdges).default([]),
    fluid: fluidSchema.optional(),
    meta: z.record(z.string().max(64), z.unknown()).optional(),
  })
  

/** Zod v4's issue shape → the flat `{path, message}` list the UI renders. */
export function formatZodIssues(error) {
  if (!error?.issues) return [{ path: 'payload', message: String(error?.message ?? 'invalid payload') }]
  return error.issues.slice(0, 40).map((issue) => ({
    path: issue.path.join('.') || 'payload',
    message: issue.message,
  }))
}

/**
 * Validate + normalise a payload. Returns `{ ok, data, errors }` — never throws,
 * so both the Express handler and the React save button can treat it the same.
 *
 * Structural integrity checks that Zod cannot express (dangling wires, duplicate
 * ids, self-loops) are applied afterwards.
 */
export function validateProject(payload) {
  const result = projectPayloadSchema.safeParse(payload)
  if (!result.success) {
    return { ok: false, data: null, errors: formatZodIssues(result.error) }
  }
  const data = result.data
  const errors = []
  const ids = new Set()
  for (const node of data.nodes) {
    if (ids.has(node.id)) errors.push({ path: node.id, message: 'duplicate node id' })
    ids.add(node.id)
  }
  for (const edge of data.edges) {
    if (!ids.has(edge.from.node)) errors.push({ path: edge.id, message: `wire source "${edge.from.node}" does not exist` })
    if (!ids.has(edge.to.node)) errors.push({ path: edge.id, message: `wire target "${edge.to.node}" does not exist` })
    if (edge.from.node === edge.to.node) errors.push({ path: edge.id, message: 'component wired to itself' })
  }
  if (errors.length) return { ok: false, data: null, errors }
  for (const node of data.nodes) {
    if (!Array.isArray(node.properties?.rules)) continue
    const rules = node.properties.rules
    if (rules.length > LIMITS.maxRules) {
      return { ok: false, data: null, errors: [{ path: `${node.id}.properties.rules`, message: `at most ${LIMITS.maxRules} rules` }] }
    }
    // `properties` is an open record (each device class owns its own shape), so
    // the per-type meaning of a property has to be checked here. A controller's
    // rules are the interesting case: they are code-like data the engine *runs*
    // every scan, and an unvalidated rule is the one place a payload could try
    // to steer control flow.
    for (let i = 0; i < rules.length; i++) {
      const parsed = ruleSchema.safeParse(rules[i])
      if (!parsed.success) {
        return {
          ok: false,
          data: null,
          errors: formatZodIssues(parsed.error).map((issue) => ({
            path: `${node.id}.rules.${i}.${issue.path}`,
            message: issue.message,
          })),
        }
      }
    }
  }
  return { ok: true, data, errors: [] }
}

export { ruleSchema }
