import { TFile } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import {
  ReasoningLevel,
  reasoningLevelToConfig,
} from '../../components/chat-view/chat-input/ReasoningSelect'
import { BaseLLMProvider } from '../../core/llm/base'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { McpManager } from '../../core/mcp/mcpManager'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { RequestTool } from '../../types/llm/request'
import {
  Annotation,
  LLMResponseStreaming,
  ToolCallDelta,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import {
  ToolCallRequest,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'

import { fetchAnnotationTitles } from './fetch-annotation-titles'
import { PromptGenerator } from './promptGenerator'

export type ResponseGeneratorParams = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  messages: ChatMessage[]
  conversationId: string
  enableTools: boolean
  maxAutoIterations: number
  promptGenerator: PromptGenerator
  mcpManager: McpManager
  includeBuiltinTools?: boolean
  abortSignal?: AbortSignal
  firstTokenTimeoutMs?: number
  requestParams?: {
    stream?: boolean
    temperature?: number
    top_p?: number
    max_tokens?: number
  }
  allowedToolNames?: string[]
  allowedSkillIds?: string[]
  allowedSkillNames?: string[]
  reasoningLevel?: ReasoningLevel
  maxContextOverride?: number
  currentFileContextMode?: 'full' | 'summary'
  currentFileOverride?: TFile | null
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
}

export class ResponseGenerator {
  private static readonly LOCAL_TOOL_NAMES = new Set([
    'fs_list',
    'fs_search',
    'fs_read',
    'fs_edit',
    'fs_write',
    'open_skill',
  ])

  private readonly providerClient: BaseLLMProvider<LLMProvider>
  private readonly model: ChatModel
  private readonly conversationId: string
  private readonly enableTools: boolean
  private readonly promptGenerator: PromptGenerator
  private readonly mcpManager: McpManager
  private readonly includeBuiltinTools: boolean
  private readonly abortSignal?: AbortSignal
  private readonly firstTokenTimeoutMs?: number
  private readonly receivedMessages: ChatMessage[]
  private readonly maxAutoIterations: number
  private readonly requestParams?: {
    stream?: boolean
    temperature?: number
    top_p?: number
    max_tokens?: number
  }
  private readonly allowedToolNames?: Set<string>
  private readonly allowedSkillIds?: Set<string>
  private readonly allowedSkillNames?: Set<string>
  private readonly reasoningLevel?: ReasoningLevel
  private readonly maxContextOverride?: number
  private readonly currentFileContextMode?: 'full' | 'summary'
  private readonly currentFileOverride?: TFile | null
  private readonly geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }

  private responseMessages: ChatMessage[] = [] // Response messages that are generated after the initial messages
  private subscribers: ((messages: ChatMessage[]) => void)[] = []

  constructor(params: ResponseGeneratorParams) {
    this.providerClient = params.providerClient
    this.model = params.model
    this.conversationId = params.conversationId
    this.enableTools = params.enableTools
    this.maxAutoIterations = Math.max(1, params.maxAutoIterations) // Ensure maxAutoIterations is at least 1
    this.receivedMessages = params.messages
    this.promptGenerator = params.promptGenerator
    this.mcpManager = params.mcpManager
    this.includeBuiltinTools = params.includeBuiltinTools ?? false
    this.abortSignal = params.abortSignal
    this.firstTokenTimeoutMs = params.firstTokenTimeoutMs
    this.requestParams = params.requestParams
    this.allowedToolNames = params.allowedToolNames
      ? new Set(params.allowedToolNames)
      : undefined
    this.allowedSkillIds = params.allowedSkillIds
      ? new Set(params.allowedSkillIds.map((id) => id.toLowerCase()))
      : undefined
    this.allowedSkillNames = params.allowedSkillNames
      ? new Set(params.allowedSkillNames.map((name) => name.toLowerCase()))
      : undefined
    this.reasoningLevel = params.reasoningLevel
    this.maxContextOverride = params.maxContextOverride
    this.currentFileContextMode = params.currentFileContextMode
    this.currentFileOverride = params.currentFileOverride
    this.geminiTools = params.geminiTools
  }

  public subscribe(callback: (messages: ChatMessage[]) => void) {
    this.subscribers.push(callback)

    return () => {
      this.subscribers = this.subscribers.filter((cb) => cb !== callback)
    }
  }

  public async run() {
    let completedToolRounds = 0
    let geminiEmptyAfterToolRetryUsed = false

    for (let i = 0; i < this.maxAutoIterations; i++) {
      const { toolCallRequests, assistantHasOutput } =
        await this.streamSingleResponse()
      if (toolCallRequests.length === 0) {
        const shouldRetryGeminiEmptyReply =
          this.model.providerType === 'gemini' &&
          completedToolRounds > 0 &&
          !assistantHasOutput &&
          !geminiEmptyAfterToolRetryUsed

        if (shouldRetryGeminiEmptyReply) {
          geminiEmptyAfterToolRetryUsed = true
          console.warn(
            '[Smart Composer] Gemini returned an empty assistant reply after tool execution; retrying once.',
            {
              conversationId: this.conversationId,
              model: this.model.model,
              iteration: i + 1,
            },
          )
          i -= 1 // Give Gemini one extra completion chance without consuming loop budget
          continue
        }

        return
      }

      const toolMessage: ChatToolMessage = {
        role: 'tool' as const,
        id: uuidv4(),
        toolCalls: toolCallRequests.map((toolCall) => ({
          request: toolCall,
          response: {
            status:
              this.mcpManager.isToolExecutionAllowed({
                requestToolName: toolCall.name,
                conversationId: this.conversationId,
                requestArgs: toolCall.arguments,
              }) && this.isToolAllowed(toolCall.name)
                ? ToolCallResponseStatus.Running
                : ToolCallResponseStatus.PendingApproval,
          },
        })),
      }

      this.updateResponseMessages((messages) => [...messages, toolMessage])

      await Promise.all(
        toolMessage.toolCalls
          .filter(
            (toolCall) =>
              toolCall.response.status === ToolCallResponseStatus.Running,
          )
          .map(async (toolCall) => {
            const skillPermission = this.checkSkillPermissionForToolCall(
              toolCall.request,
            )
            if (!skillPermission.allowed) {
              this.updateResponseMessages((messages) =>
                messages.map((message) =>
                  message.id === toolMessage.id && message.role === 'tool'
                    ? {
                        ...message,
                        toolCalls: message.toolCalls?.map((tc) =>
                          tc.request.id === toolCall.request.id
                            ? {
                                ...tc,
                                response: {
                                  status: ToolCallResponseStatus.Error,
                                  error:
                                    skillPermission.reason ??
                                    'Skill is not allowed for the current assistant.',
                                },
                              }
                            : tc,
                        ),
                      }
                    : message,
                ),
              )
              return
            }

            const response = await this.mcpManager.callTool({
              name: toolCall.request.name,
              args: toolCall.request.arguments,
              id: toolCall.request.id,
              signal: this.abortSignal,
            })
            this.updateResponseMessages((messages) =>
              messages.map((message) =>
                message.id === toolMessage.id && message.role === 'tool'
                  ? {
                      ...message,
                      toolCalls: message.toolCalls?.map((tc) =>
                        tc.request.id === toolCall.request.id
                          ? {
                              ...tc,
                              response,
                            }
                          : tc,
                      ),
                    }
                  : message,
              ),
            )
          }),
      )

      const updatedToolMessage = this.responseMessages.find(
        (message) => message.id === toolMessage.id && message.role === 'tool',
      ) as ChatToolMessage | undefined
      if (
        !updatedToolMessage?.toolCalls?.every((toolCall) =>
          [
            ToolCallResponseStatus.Success,
            ToolCallResponseStatus.Error,
          ].includes(toolCall.response.status),
        )
      ) {
        // Exit the auto-iteration loop if any tool call hasn't completed
        // Only 'success' or 'error' states are considered complete
        return
      }

      completedToolRounds += 1
    }
  }

  private async streamSingleResponse(): Promise<{
    toolCallRequests: ToolCallRequest[]
    assistantHasOutput: boolean
  }> {
    const availableTools = this.enableTools
      ? await this.mcpManager.listAvailableTools({
          includeBuiltinTools: this.includeBuiltinTools,
        })
      : []
    const filteredTools = availableTools.filter((tool) =>
      this.isToolAllowed(tool.name),
    )
    const hasTools = filteredTools.length > 0

    if (this.enableTools && !hasTools) {
      console.warn(
        '[Smart Composer] Agent tools enabled but request has no available tools.',
        {
          conversationId: this.conversationId,
          includeBuiltinTools: this.includeBuiltinTools,
          availableToolsCount: availableTools.length,
          allowedToolNamesCount: this.allowedToolNames?.size ?? 0,
        },
      )
    }

    const requestMessages = await this.promptGenerator.generateRequestMessages({
      messages: [...this.receivedMessages, ...this.responseMessages],
      hasTools,
      maxContextOverride: this.maxContextOverride,
      model: this.model,
      currentFileContextMode: this.currentFileContextMode,
      currentFileOverride: this.currentFileOverride,
    })

    // Set tools to undefined when no tools are available since some providers
    // reject empty tools arrays.
    const tools: RequestTool[] | undefined =
      filteredTools.length > 0
        ? filteredTools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                ...tool.inputSchema,
                properties: tool.inputSchema.properties ?? {},
              },
            },
          }))
        : undefined

    const responseStart = Date.now()

    const shouldStream = this.requestParams?.stream ?? true

    const effectiveModel = this.reasoningLevel
      ? ({
          ...this.model,
          ...reasoningLevelToConfig(this.reasoningLevel, this.model),
        } as ChatModel)
      : this.model

    const runNonStreaming = async (): Promise<{
      toolCallRequests: ToolCallRequest[]
      assistantHasOutput: boolean
    }> => {
      const response = await this.providerClient.generateResponse(
        effectiveModel,
        {
          model: effectiveModel.model,
          messages: requestMessages,
          tools,
          tool_choice: tools ? 'auto' : undefined,
          stream: false,
          temperature: this.requestParams?.temperature,
          top_p: this.requestParams?.top_p,
          max_tokens: this.requestParams?.max_tokens,
        },
        {
          signal: this.abortSignal,
          geminiTools: this.geminiTools,
        },
      )

      // Ensure assistant message exists and populate content and metadata
      this.responseMessages.push({
        role: 'assistant',
        content: response.choices[0]?.message?.content ?? '',
        id: uuidv4(),
        metadata: {
          model: effectiveModel,
          usage: response.usage,
          durationMs: Date.now() - responseStart,
          generationState: 'completed',
        },
      })
      const responseMessageId = this.responseMessages.at(-1)!.id

      // Merge annotations (if any)
      const annotations = response.choices[0]?.message?.annotations
      if (annotations) {
        this.updateResponseMessages((messages) =>
          messages.map((message) =>
            message.id === responseMessageId && message.role === 'assistant'
              ? {
                  ...message,
                  annotations,
                }
              : message,
          ),
        )
      }

      // Tool call requests from non-streaming response
      const toolCallRequests = (response.choices[0]?.message?.tool_calls ?? [])
        .map((toolCall): ToolCallRequest | null => {
          if (!toolCall.function?.name) return null
          const base: ToolCallRequest = {
            id: toolCall.id ?? uuidv4(),
            name: this.normalizeToolCallName(toolCall.function.name),
          }
          return toolCall.function.arguments
            ? { ...base, arguments: toolCall.function.arguments }
            : base
        })
        .filter((t): t is ToolCallRequest => t !== null)

      if (tools && toolCallRequests.length === 0) {
        console.warn(
          '[Smart Composer] Model returned no tool calls in non-stream mode.',
          {
            conversationId: this.conversationId,
            model: effectiveModel.model,
            providerType: this.model.providerType,
          },
        )
      }

      // Update assistant message with toolCallRequests
      this.updateResponseMessages((messages) =>
        messages.map((message) =>
          message.id === responseMessageId && message.role === 'assistant'
            ? {
                ...message,
                toolCallRequests:
                  toolCallRequests.length > 0 ? toolCallRequests : undefined,
              }
            : message,
        ),
      )

      return {
        toolCallRequests,
        assistantHasOutput: this.hasAssistantOutput({
          content: response.choices[0]?.message?.content,
          reasoning: response.choices[0]?.message?.reasoning,
          annotations,
        }),
      }
    }

    if (!shouldStream) {
      // Non-streaming path
      return runNonStreaming()
    }

    // Streaming path (with fallback on protocol/EOF errors)
    let responseIterable: AsyncIterable<LLMResponseStreaming>
    let streamAbortController: AbortController | null = null
    let abortListener: (() => void) | null = null
    const firstTokenTimeoutMs =
      typeof this.firstTokenTimeoutMs === 'number'
        ? this.firstTokenTimeoutMs
        : null
    const shouldUseFirstTokenTimeout =
      firstTokenTimeoutMs !== null && firstTokenTimeoutMs > 0
    try {
      const signal = shouldUseFirstTokenTimeout
        ? (() => {
            streamAbortController = new AbortController()
            if (this.abortSignal) {
              if (this.abortSignal.aborted) {
                streamAbortController.abort()
              } else {
                const onAbort = () => streamAbortController?.abort()
                this.abortSignal.addEventListener('abort', onAbort, {
                  once: true,
                })
                abortListener = onAbort
              }
            }
            return streamAbortController.signal
          })()
        : this.abortSignal
      responseIterable = await this.providerClient.streamResponse(
        effectiveModel,
        {
          model: effectiveModel.model,
          messages: requestMessages,
          tools,
          tool_choice: tools ? 'auto' : undefined,
          stream: true,
          temperature: this.requestParams?.temperature,
          top_p: this.requestParams?.top_p,
          max_tokens: this.requestParams?.max_tokens,
        },
        {
          signal,
          geminiTools: this.geminiTools,
        },
      )
    } catch (error) {
      if (abortListener && this.abortSignal) {
        this.abortSignal.removeEventListener('abort', abortListener)
      }
      const msg = String(error?.message ?? '')
      const shouldFallback =
        /protocol error|unexpected EOF|incomplete envelope/i.test(msg)
      if (shouldFallback) {
        return runNonStreaming()
      }
      throw error
    }

    // Create a new assistant message for the response if it doesn't exist
    if (this.responseMessages.at(-1)?.role !== 'assistant') {
      this.responseMessages.push({
        role: 'assistant',
        content: '',
        id: uuidv4(),
        metadata: {
          model: effectiveModel,
          generationState: 'streaming',
        },
      })
    }
    const lastMessage = this.responseMessages.at(-1)
    if (lastMessage?.role !== 'assistant') {
      throw new Error('Last message is not an assistant message')
    }
    const responseMessageId = lastMessage.id
    let responseToolCalls: Record<number, ToolCallDelta> = {}
    let finalizedState: 'completed' | 'aborted' | null = null
    const finalizeGenerationState = (state: 'completed' | 'aborted'): void => {
      if (finalizedState) return
      finalizedState = state
      this.updateResponseMessages((messages) =>
        messages.map((message) =>
          message.id === responseMessageId && message.role === 'assistant'
            ? {
                ...message,
                metadata: {
                  ...message.metadata,
                  generationState: state,
                },
              }
            : message,
        ),
      )
    }
    let generationAbortListener: (() => void) | null = null
    if (this.abortSignal) {
      const onAbort = () => finalizeGenerationState('aborted')
      this.abortSignal.addEventListener('abort', onAbort, { once: true })
      generationAbortListener = onAbort
    }
    const cleanupAbortListener = () => {
      if (abortListener && this.abortSignal) {
        this.abortSignal.removeEventListener('abort', abortListener)
      }
    }
    try {
      if (shouldUseFirstTokenTimeout && streamAbortController) {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        const iterator = responseIterable[Symbol.asyncIterator]()
        const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
          timeoutHandle = setTimeout(
            () => resolve({ timeout: true }),
            firstTokenTimeoutMs,
          )
        })
        const firstResult = await Promise.race([
          iterator.next(),
          timeoutPromise,
        ])
        if ('timeout' in firstResult) {
          streamAbortController.abort()
          if (timeoutHandle) clearTimeout(timeoutHandle)
          cleanupAbortListener()
          return runNonStreaming()
        }
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (!firstResult.done) {
          const { updatedToolCalls } = this.processChunk(
            firstResult.value,
            responseMessageId,
            responseToolCalls,
          )
          responseToolCalls = updatedToolCalls
        }
        for await (const chunk of {
          [Symbol.asyncIterator]: () => iterator,
        }) {
          const { updatedToolCalls } = this.processChunk(
            chunk,
            responseMessageId,
            responseToolCalls,
          )
          responseToolCalls = updatedToolCalls
        }
      } else {
        for await (const chunk of responseIterable) {
          const { updatedToolCalls } = this.processChunk(
            chunk,
            responseMessageId,
            responseToolCalls,
          )
          responseToolCalls = updatedToolCalls
        }
      }
    } finally {
      cleanupAbortListener()
      if (generationAbortListener && this.abortSignal) {
        this.abortSignal.removeEventListener('abort', generationAbortListener)
      }
    }
    if (!this.abortSignal?.aborted) {
      finalizeGenerationState('completed')
    }
    const durationMs = Date.now() - responseStart
    this.updateResponseMessages((messages) =>
      messages.map((message) =>
        message.id === responseMessageId && message.role === 'assistant'
          ? {
              ...message,
              metadata: {
                ...message.metadata,
                durationMs,
                generationState:
                  message.metadata?.generationState ?? 'completed',
              },
            }
          : message,
      ),
    )
    const toolCallRequests: ToolCallRequest[] = Object.values(responseToolCalls)
      .map((toolCall) => {
        // filter out invalid tool calls without a name
        if (!toolCall.function?.name) {
          return null
        }
        return {
          id: toolCall.id ?? uuidv4(),
          name: this.normalizeToolCallName(toolCall.function.name),
          arguments: toolCall.function.arguments,
        }
      })
      .filter((toolCall) => toolCall !== null)

    if (tools && toolCallRequests.length === 0) {
      console.warn(
        '[Smart Composer] Model returned no tool calls in stream mode.',
        {
          conversationId: this.conversationId,
          model: effectiveModel.model,
          providerType: this.model.providerType,
        },
      )
    }

    this.updateResponseMessages((messages) =>
      messages.map((message) =>
        message.id === responseMessageId && message.role === 'assistant'
          ? {
              ...message,
              toolCallRequests:
                toolCallRequests.length > 0 ? toolCallRequests : undefined,
            }
          : message,
      ),
    )
    const finalizedAssistantMessage = this.responseMessages.find(
      (message): message is ChatAssistantMessage =>
        message.id === responseMessageId && message.role === 'assistant',
    )
    return {
      toolCallRequests: toolCallRequests,
      assistantHasOutput: this.hasAssistantOutput({
        content: finalizedAssistantMessage?.content,
        reasoning: finalizedAssistantMessage?.reasoning,
        annotations: finalizedAssistantMessage?.annotations,
      }),
    }
  }

  private processChunk(
    chunk: LLMResponseStreaming,
    responseMessageId: string,
    responseToolCalls: Record<number, ToolCallDelta>,
  ): {
    updatedToolCalls: Record<number, ToolCallDelta>
  } {
    const content = chunk.choices[0]?.delta?.content ?? ''
    const reasoning = chunk.choices[0]?.delta?.reasoning
    const toolCalls = chunk.choices[0]?.delta?.tool_calls
    const annotations = chunk.choices[0]?.delta?.annotations

    const updatedToolCalls = toolCalls
      ? this.mergeToolCallDeltas(toolCalls, responseToolCalls)
      : responseToolCalls

    if (annotations) {
      // For annotations with empty titles, fetch the title of the URL and update the chat messages
      fetchAnnotationTitles(annotations, (url, title) => {
        this.updateResponseMessages((messages) =>
          messages.map((message) =>
            message.id === responseMessageId && message.role === 'assistant'
              ? {
                  ...message,
                  annotations: message.annotations?.map((a) =>
                    a.type === 'url_citation' && a.url_citation.url === url
                      ? {
                          ...a,
                          url_citation: {
                            ...a.url_citation,
                            title: title ?? undefined,
                          },
                        }
                      : a,
                  ),
                }
              : message,
          ),
        )
      })
    }

    this.updateResponseMessages((messages) =>
      messages.map((message) =>
        message.id === responseMessageId && message.role === 'assistant'
          ? {
              ...message,
              content: message.content + content,
              reasoning: reasoning
                ? (message.reasoning ?? '') + reasoning
                : message.reasoning,
              annotations: this.mergeAnnotations(
                message.annotations,
                annotations,
              ),
              metadata: {
                ...message.metadata,
                usage: chunk.usage ?? message.metadata?.usage,
              },
            }
          : message,
      ),
    )

    return {
      updatedToolCalls,
    }
  }

  private updateResponseMessages(
    updaterFunction: (messages: ChatMessage[]) => ChatMessage[],
  ) {
    this.responseMessages = updaterFunction(this.responseMessages)
    this.notifySubscribers(this.responseMessages)
  }

  private notifySubscribers(messages: ChatMessage[]) {
    this.subscribers.forEach((callback) => {
      callback(messages)
    })
  }

  private mergeToolCallDeltas(
    toolCalls: ToolCallDelta[],
    existingToolCalls: Record<number, ToolCallDelta>,
  ): Record<number, ToolCallDelta> {
    const merged = { ...existingToolCalls }

    for (const toolCall of toolCalls) {
      const { index } = toolCall

      if (!merged[index]) {
        merged[index] = toolCall
        continue
      }

      const mergedToolCall: ToolCallDelta = {
        index,
        id: merged[index].id ?? toolCall.id,
        type: merged[index].type ?? toolCall.type,
      }

      if (merged[index].function || toolCall.function) {
        const existingArgs = merged[index].function?.arguments
        const newArgs = toolCall.function?.arguments

        mergedToolCall.function = {
          name: merged[index].function?.name ?? toolCall.function?.name,
          arguments:
            existingArgs || newArgs
              ? [existingArgs ?? '', newArgs ?? ''].join('')
              : undefined,
        }
      }

      merged[index] = mergedToolCall
    }

    return merged
  }

  private mergeAnnotations(
    prevAnnotations?: Annotation[],
    newAnnotations?: Annotation[],
  ): Annotation[] | undefined {
    if (!prevAnnotations) return newAnnotations
    if (!newAnnotations) return prevAnnotations

    const mergedAnnotations = [...prevAnnotations]
    for (const newAnnotation of newAnnotations) {
      if (
        !mergedAnnotations.find(
          (annotation) =>
            annotation.url_citation.url === newAnnotation.url_citation.url,
        )
      ) {
        mergedAnnotations.push(newAnnotation)
      }
    }
    return mergedAnnotations
  }

  private hasAssistantOutput({
    content,
    reasoning,
    annotations,
  }: {
    content?: string | null
    reasoning?: string | null
    annotations?: Annotation[]
  }): boolean {
    const hasContent = typeof content === 'string' && content.trim().length > 0
    const hasReasoning =
      typeof reasoning === 'string' && reasoning.trim().length > 0
    const hasAnnotations = Boolean(annotations && annotations.length > 0)
    return hasContent || hasReasoning || hasAnnotations
  }

  private normalizeToolCallName(toolName: string): string {
    if (toolName.includes(McpManager.TOOL_NAME_DELIMITER)) {
      return toolName
    }
    if (!ResponseGenerator.LOCAL_TOOL_NAMES.has(toolName)) {
      return toolName
    }
    return `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${toolName}`
  }

  private isToolAllowed(toolName: string): boolean {
    if (this.isOpenSkillToolName(toolName)) {
      const hasAllowedSkills =
        (this.allowedSkillIds?.size ?? 0) > 0 ||
        (this.allowedSkillNames?.size ?? 0) > 0
      if (!hasAllowedSkills) {
        return false
      }
    }

    if (!this.allowedToolNames) {
      return true
    }
    return this.allowedToolNames.has(toolName)
  }

  private isOpenSkillToolName(toolName: string): boolean {
    try {
      const parsed = parseToolName(toolName)
      return (
        parsed.serverName === getLocalFileToolServerName() &&
        parsed.toolName === 'open_skill'
      )
    } catch {
      return false
    }
  }

  private parseToolArguments(
    args?: Record<string, unknown> | string,
  ): Record<string, unknown> {
    if (!args) {
      return {}
    }
    if (typeof args === 'string') {
      if (args.trim().length === 0) {
        return {}
      }
      try {
        const parsed = JSON.parse(args)
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>
        }
        return {}
      } catch {
        return {}
      }
    }
    return args
  }

  private checkSkillPermissionForToolCall(request: ToolCallRequest): {
    allowed: boolean
    reason?: string
  } {
    try {
      const parsed = parseToolName(request.name)
      if (
        parsed.serverName !== getLocalFileToolServerName() ||
        parsed.toolName !== 'open_skill'
      ) {
        return { allowed: true }
      }

      if (!this.allowedSkillIds && !this.allowedSkillNames) {
        return {
          allowed: false,
          reason: 'open_skill is not allowed in the current conversation.',
        }
      }

      const args = this.parseToolArguments(request.arguments)
      const id = typeof args.id === 'string' ? args.id.trim().toLowerCase() : ''
      const name =
        typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''

      const allowedById = Boolean(id) && Boolean(this.allowedSkillIds?.has(id))
      const allowedByName =
        Boolean(name) && Boolean(this.allowedSkillNames?.has(name))

      if (!allowedById && !allowedByName) {
        return {
          allowed: false,
          reason: 'Skill is not enabled for the current assistant.',
        }
      }

      return { allowed: true }
    } catch {
      return { allowed: true }
    }
  }
}
