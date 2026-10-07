/**
 * Phoenix tracing, set up the way the OpenInference TypeSafe instrumentation
 * documents it (js/packages/openinference-instrumentation-typesafe):
 *
 *   NodeTracerProvider (resource: openinference.project.name)
 *     └─ OTLP/proto exporter → {phoenix}/v1/traces
 *   TypeSafeInstrumentation.manuallyInstrument(TypeSafe)   // ESM
 *
 * The instrumentation emits one OpenInference DECISION span per
 * `TypeSafeClient.systemOne` call with the decision.* conventions
 * (spec/decision_spans.md). Effect's own spans (the per-item triage spans)
 * are routed into the same provider through @effect/opentelemetry, and the
 * Classifier runs each SDK call inside the Effect span's OpenTelemetry
 * context so the DECISION span nests under `triage.classify`.
 */
import { OtelTracer, Resource } from "@effect/opentelemetry"
import { TypeSafeInstrumentation } from "@arizeai/openinference-instrumentation-typesafe"
import { SEMRESATTRS_PROJECT_NAME, SemanticConventions } from "@arizeai/openinference-semantic-conventions"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchSpanProcessor, type ReadableSpan, type Span as SdkSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import * as TypeSafe from "@typesafe-ai/sdk"
import { createRequire } from "node:module"
import { Effect, Layer } from "effect"
import type { PhoenixConfig } from "./config/AppConfig.ts"

export const SERVICE_NAME = "px-triage"
/** Single source of truth for the version: package.json (works from src/ and dist/). */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version

/**
 * Only OpenInference spans reach Phoenix. Anything without
 * `openinference.span.kind` (HTTP client spans, internal Effect spans) is
 * dropped at export so the project shows triage, decision, and tool spans only.
 */
class OpenInferenceOnly implements SpanProcessor {
  private readonly inner: SpanProcessor
  constructor(inner: SpanProcessor) {
    this.inner = inner
  }
  onStart(span: SdkSpan, parentContext: Parameters<SpanProcessor["onStart"]>[1]): void {
    this.inner.onStart(span, parentContext)
  }
  onEnd(span: ReadableSpan): void {
    if (span.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND] !== undefined) this.inner.onEnd(span)
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush()
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}

const setupProvider = (phoenix: PhoenixConfig) => {
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
      new OpenInferenceOnly(
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${phoenix.url.replace(/\/+$/, "")}/v1/traces`, headers }),
          { scheduledDelayMillis: 500 }
        )
      )
    ]
  })
  provider.register()
  const instrumentation = new TypeSafeInstrumentation({ tracerProvider: provider })
  instrumentation.manuallyInstrument(TypeSafe)
  return {
    provider,
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
        Effect.sync(() => setupProvider(phoenix)),
        (t) => Effect.promise(() => t.shutdown()).pipe(Effect.ignore)
      )
      return OtelTracer.layer.pipe(
        Layer.provide(Layer.succeed(OtelTracer.OtelTracerProvider, tracing.provider)),
        Layer.provide(Resource.layer({ serviceName: SERVICE_NAME, serviceVersion: VERSION, attributes: { [SEMRESATTRS_PROJECT_NAME]: phoenix.projectName } }))
      )
    })
  )
}
