/**
 * Phoenix tracing following the OpenInference decision-span conventions
 * (spec/decision_spans.md) and the structure of the official TypeSafe
 * instrumentation (js/packages/openinference-instrumentation-typesafe on main):
 *
 *   NodeTracerProvider (resource: openinference.project.name) → OTLP/proto → {phoenix}/v1/traces
 *   traceSystemOne(): one DECISION span per `systemOne` call, named
 *   "TypeSafeClient.systemOne", with JSON input/output, decision.* model
 *   attributes and decision.token_count.*.
 *
 * The published instrumentation package (0.1.0) still emits LLM spans with
 * llm.* attributes, so the wrapper here mirrors the unreleased decision-span
 * version instead of depending on the package.
 *
 * Effect's own spans are routed into the same provider via @effect/opentelemetry.
 */
import { OtelTracer, Resource } from "@effect/opentelemetry"
import { getDecisionAttributes, getInputAttributes, getLLMAttributes, getOutputAttributes, OITracer, safelyJSONStringify } from "@arizeai/openinference-core"
import {
  DecisionProvider,
  DecisionSystem,
  MimeType,
  OpenInferenceSpanKind,
  SEMRESATTRS_PROJECT_NAME,
  SemanticConventions
} from "@arizeai/openinference-semantic-conventions"
import { context as otelContext, type Span as OtelSpan, SpanKind, SpanStatusCode, trace as otelTrace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { APIError, type Questions, type RequestOptions, type SystemOneRequest, type SystemOneResult, type TypeSafeClient } from "@typesafe-ai/sdk"
import { Effect, Layer } from "effect"
import type { PhoenixConfig } from "./config/AppConfig.js"

export const SERVICE_NAME = "px-triage"
export const VERSION = "0.1.0"

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
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${phoenix.url.replace(/\/+$/, "")}/v1/traces`, headers }),
        { scheduledDelayMillis: 500 }
      )
    ]
  })
  provider.register()
  return provider
}

/**
 * Provides Effect's Tracer backed by the shared OpenTelemetry provider, and
 * flushes + shuts the provider down when the layer's scope closes.
 */
export const tracingLayer = (phoenix: PhoenixConfig | undefined): Layer.Layer<never> => {
  if (!phoenix) return Layer.empty
  return Layer.unwrap(
    Effect.gen(function*() {
      const provider = yield* Effect.acquireRelease(
        Effect.sync(() => setupProvider(phoenix)),
        (p) => Effect.promise(() => p.forceFlush().then(() => p.shutdown())).pipe(Effect.ignore)
      )
      return OtelTracer.layer.pipe(
        Layer.provide(Layer.succeed(OtelTracer.OtelTracerProvider, provider)),
        Layer.provide(Resource.layer({ serviceName: SERVICE_NAME, serviceVersion: VERSION, attributes: { [SEMRESATTRS_PROJECT_NAME]: phoenix.projectName } }))
      )
    })
  )
}

// ---------------------------------------------------------------------------
// DECISION span for TypeSafeClient.systemOne
// ---------------------------------------------------------------------------

const oiTracer = new OITracer({ tracer: otelTrace.getTracer(SERVICE_NAME, VERSION) })

/**
 * Call `client.systemOne` inside an OpenInference DECISION span, parented to
 * `parent` (an OpenTelemetry span, e.g. the current Effect span bridged via
 * @effect/opentelemetry) or to the active OTel context when `parent` is absent.
 */
export const traceSystemOne = async <Q extends Questions>(
  client: TypeSafeClient,
  request: SystemOneRequest<Q>,
  options: RequestOptions,
  parent: OtelSpan | undefined
): Promise<SystemOneResult<Q>> => {
  const parentCtx = parent ? otelTrace.setSpan(otelContext.active(), parent) : otelContext.active()
  const requestModel = request.model ?? client.defaultModel
  const span = oiTracer.startSpan(
    "TypeSafeClient.systemOne",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.DECISION,
        ...getDecisionAttributes({ system: DecisionSystem.TYPESAFE, provider: DecisionProvider.TYPESAFE, requestModelName: requestModel }),
        ...getInputAttributes({ value: safelyJSONStringify({ ...request, model: requestModel }) ?? "", mimeType: MimeType.JSON }),
        ...getLLMAttributes({ invocationParameters: { model: requestModel, timeout: options.timeout } })
      }
    },
    parentCtx
  )
  try {
    const result = await otelContext.with(otelTrace.setSpan(parentCtx, span), () => client.systemOne(request, options))
    span.setAttributes({
      ...getOutputAttributes({ value: safelyJSONStringify(result) ?? "", mimeType: MimeType.JSON }),
      ...getDecisionAttributes({
        modelName: result.model,
        responseModelName: result.model,
        tokenCount: { input: result.usage.input_tokens, output: result.usage.output_tokens }
      })
    })
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (error) {
    if (error instanceof APIError) span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, error.status)
    span.recordException(error instanceof Error ? error : String(error))
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    span.end()
  }
}
