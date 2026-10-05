/**
 * Phoenix tracing, set up the way the OpenInference TypeSafe instrumentation
 * documents it (js/packages/openinference-instrumentation-typesafe):
 *
 *   NodeTracerProvider (resource: openinference.project.name)
 *     └─ OTLP/proto exporter → {phoenix}/v1/traces
 *   TypeSafeInstrumentation.manuallyInstrument(TypeSafe)   // ESM
 *
 * The instrumentation emits one OpenInference DECISION span per
 * `TypeSafeClient.systemOne` call (JSON input/output, model, token usage).
 * Effect's own spans (the per-item `triage.item` CHAIN span) are routed into
 * the same provider through `@effect/opentelemetry`, so the SDK span nests
 * under the triage span in Phoenix.
 */
import { OtelTracer, Resource } from "@effect/opentelemetry"
import { TypeSafeInstrumentation } from "@arizeai/openinference-instrumentation-typesafe"
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import * as TypeSafe from "@typesafe-ai/sdk"
import { Effect, Layer } from "effect"
import type { PhoenixConfig } from "./config/AppConfig.js"

export const SERVICE_NAME = "px-triage"
export const VERSION = "0.1.0"

const setupTracing = (phoenix: PhoenixConfig) => {
  const headers: Record<string, string> = phoenix.apiKey
    ? { Authorization: `Bearer ${phoenix.apiKey}`, api_key: phoenix.apiKey }
    : {}
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [SEMRESATTRS_PROJECT_NAME]: phoenix.projectName,
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: VERSION
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${phoenix.url.replace(/\/+$/, "")}/v1/traces`, headers }),
        { scheduledDelayMillis: 500 }
      )
    ]
  })
  provider.register()
  const instrumentation = new TypeSafeInstrumentation({ tracerProvider: provider })
  instrumentation.manuallyInstrument(TypeSafe)
  return {
    provider,
    instrumentation,
    shutdown: async () => {
      await provider.forceFlush()
      instrumentation.disable()
      await provider.shutdown()
    }
  }
}

/**
 * Provides Effect's Tracer backed by the shared OpenTelemetry provider, and
 * flushes + shuts the provider down when the layer's scope closes.
 */
export const tracingLayer = (phoenix: PhoenixConfig | undefined): Layer.Layer<never> => {
  if (!phoenix) return Layer.empty
  return Layer.unwrap(
    Effect.gen(function*() {
      const tracing = yield* Effect.acquireRelease(
        Effect.sync(() => setupTracing(phoenix)),
        (t) => Effect.promise(() => t.shutdown()).pipe(Effect.ignore)
      )
      return OtelTracer.layer.pipe(
        Layer.provide(Layer.succeed(OtelTracer.OtelTracerProvider, tracing.provider)),
        Layer.provide(Resource.layer({ serviceName: SERVICE_NAME, serviceVersion: VERSION, attributes: { [SEMRESATTRS_PROJECT_NAME]: phoenix.projectName } }))
      )
    })
  )
}
