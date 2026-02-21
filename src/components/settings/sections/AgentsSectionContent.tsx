import { BookOpen, Cpu, User, Wrench } from 'lucide-react'
import { App } from 'obsidian'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { parseToolName } from '../../../core/mcp/tool-name-utils'
import {
  LiteSkillEntry,
  listLiteSkillEntries,
} from '../../../core/skills/liteSkills'
import {
  getDisabledSkillIdSet,
  resolveAssistantSkillPolicy,
} from '../../../core/skills/skillPolicy'
import {
  AgentPersona,
  Assistant,
  AssistantSkillLoadMode,
} from '../../../types/assistant.types'
import { McpTool } from '../../../types/mcp.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SimpleSelect } from '../../common/SimpleSelect'
import { openIconPicker } from '../assistants/AssistantIconPicker'

type AgentsSectionContentProps = {
  app: App
  onClose: () => void
  initialAssistantId?: string
  initialCreate?: boolean
}

type AgentEditorTab = 'profile' | 'tools' | 'skills' | 'model'

type AgentToolView = {
  fullName: string
  displayName: string
  description: string
}

const BUILTIN_TOOL_LABEL_KEYS: Record<
  string,
  {
    key: string
    descKey: string
    fallback: string
    descFallback: string
  }
> = {
  fs_list: {
    key: 'settings.agent.builtinFsListLabel',
    descKey: 'settings.agent.builtinFsListDesc',
    fallback: 'Read Vault',
    descFallback:
      'List directory structure under a vault path. Useful for workspace orientation.',
  },
  fs_search: {
    key: 'settings.agent.builtinFsSearchLabel',
    descKey: 'settings.agent.builtinFsSearchDesc',
    fallback: 'Search Vault',
    descFallback: 'Search files, folders, or markdown content in vault.',
  },
  fs_read: {
    key: 'settings.agent.builtinFsReadLabel',
    descKey: 'settings.agent.builtinFsReadDesc',
    fallback: 'Read File',
    descFallback: 'Read line ranges from multiple vault files by path.',
  },
  fs_edit: {
    key: 'settings.agent.builtinFsEditLabel',
    descKey: 'settings.agent.builtinFsEditDesc',
    fallback: 'Edit File',
    descFallback: 'Apply exact text replacement within a single file.',
  },
  fs_write: {
    key: 'settings.agent.builtinFsWriteLabel',
    descKey: 'settings.agent.builtinFsWriteDesc',
    fallback: 'Write Vault',
    descFallback: 'Execute vault write operations for files and folders.',
  },
  open_skill: {
    key: 'settings.agent.builtinOpenSkillLabel',
    descKey: 'settings.agent.builtinOpenSkillDesc',
    fallback: 'Open Skill',
    descFallback: 'Load a skill markdown file by id or name.',
  },
}

const AGENT_EDITOR_TABS: AgentEditorTab[] = [
  'profile',
  'tools',
  'skills',
  'model',
]

const AGENT_EDITOR_TAB_ICONS = {
  profile: User,
  tools: Wrench,
  skills: BookOpen,
  model: Cpu,
} as const

const DEFAULT_PERSONA: AgentPersona = 'balanced'

const AGENT_MODEL_DEFAULTS = {
  temperature: 0.7,
  topP: 0.9,
  maxOutputTokens: 4096,
} as const

function clampTemperature(value: number): number {
  return Math.min(2, Math.max(0, value))
}

function clampTopP(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clampMaxOutputTokens(value: number): number {
  return Math.max(1, Math.floor(value))
}

function createNewAgent(defaultModelId: string): Assistant {
  return {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    systemPrompt: '',
    persona: DEFAULT_PERSONA,
    modelId: defaultModelId,
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    enabledSkills: [],
    skillPreferences: {},
    temperature: undefined,
    topP: undefined,
    maxOutputTokens: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function toDraftAgent(
  assistant: Assistant,
  fallbackModelId: string,
): Assistant {
  return {
    ...assistant,
    persona: assistant.persona ?? DEFAULT_PERSONA,
    modelId: assistant.modelId ?? fallbackModelId,
    enabledToolNames: assistant.enabledToolNames ?? [],
    enabledSkills: assistant.enabledSkills ?? [],
    skillPreferences: assistant.skillPreferences ?? {},
    enableTools: assistant.enableTools ?? true,
    includeBuiltinTools: assistant.includeBuiltinTools ?? true,
    temperature: assistant.temperature,
    topP: assistant.topP,
    maxOutputTokens: assistant.maxOutputTokens,
  }
}

function normalizeToolSelection(
  enabledToolNames: string[] | undefined,
  availableTools: McpTool[],
): string[] {
  if (!enabledToolNames || enabledToolNames.length === 0) {
    return []
  }
  const available = new Set(availableTools.map((tool) => tool.name))
  return enabledToolNames.filter((toolName) => available.has(toolName))
}

export function AgentsSectionContent({
  app,
  onClose,
  initialAssistantId,
  initialCreate,
}: AgentsSectionContentProps) {
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const assistants = settings.assistants || []
  const isDirectEditEntry = Boolean(initialAssistantId)
  const isDirectCreateEntry = Boolean(initialCreate)
  const isDirectEntry = isDirectEditEntry || isDirectCreateEntry
  const [draftAgent, setDraftAgent] = useState<Assistant | null>(() => {
    if (initialCreate) {
      const draft = createNewAgent(settings.chatModelId)
      draft.name = t('settings.agent.editorDefaultName', 'New agent')
      return draft
    }
    if (!initialAssistantId) {
      return null
    }
    const initialAssistant = assistants.find(
      (assistant) => assistant.id === initialAssistantId,
    )
    if (!initialAssistant) {
      return null
    }
    return toDraftAgent(initialAssistant, settings.chatModelId)
  })
  const [activeTab, setActiveTab] = useState<AgentEditorTab>('profile')
  const [availableTools, setAvailableTools] = useState<McpTool[]>([])
  const [modelParamCache, setModelParamCache] = useState<{
    temperature: number
    topP: number
    maxOutputTokens: number
  }>(() => ({
    temperature: AGENT_MODEL_DEFAULTS.temperature,
    topP: AGENT_MODEL_DEFAULTS.topP,
    maxOutputTokens: AGENT_MODEL_DEFAULTS.maxOutputTokens,
  }))
  const activeTabIndex = AGENT_EDITOR_TABS.findIndex((tab) => tab === activeTab)
  const activeTabIndexRef = useRef(activeTabIndex)
  const tabsNavRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const updateTabsGlider = useCallback(() => {
    const nav = tabsNavRef.current
    const index = activeTabIndexRef.current
    const activeButton = tabRefs.current[index]

    if (!nav || !activeButton || index < 0) {
      return
    }

    nav.style.setProperty(
      '--smtcmp-agent-tab-glider-left',
      `${activeButton.offsetLeft}px`,
    )
    nav.style.setProperty(
      '--smtcmp-agent-tab-glider-width',
      `${activeButton.offsetWidth}px`,
    )
  }, [])

  useLayoutEffect(() => {
    activeTabIndexRef.current = activeTabIndex
    updateTabsGlider()
  }, [activeTabIndex, updateTabsGlider])

  useEffect(() => {
    const nav = tabsNavRef.current
    if (!nav) {
      return
    }

    if (typeof ResizeObserver === 'undefined') {
      updateTabsGlider()
      return
    }

    const observer = new ResizeObserver(() => updateTabsGlider())
    observer.observe(nav)
    tabRefs.current.forEach((button) => {
      if (button) {
        observer.observe(button)
      }
    })

    return () => observer.disconnect()
  }, [updateTabsGlider])

  useEffect(() => {
    let mounted = true
    void plugin
      .getMcpManager()
      .then((manager) =>
        manager.listAvailableTools({ includeBuiltinTools: true }),
      )
      .then((tools) => {
        if (mounted) {
          setAvailableTools(tools)
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load available tools for agent editor', error)
      })

    return () => {
      mounted = false
    }
  }, [plugin])

  const agentModelOptionGroups = useMemo(() => {
    const providerOrder = settings.providers.map((provider) => provider.id)
    const providerIdsInModels = Array.from(
      new Set(settings.chatModels.map((model) => model.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]

    return orderedProviderIds
      .map((providerId) => {
        const models = settings.chatModels.filter(
          (model) => model.providerId === providerId,
        )
        if (models.length === 0) {
          return null
        }
        return {
          label: providerId,
          options: models.map((model) => ({
            value: model.id,
            label: model.name?.trim()
              ? model.name.trim()
              : model.model || model.id,
          })),
        }
      })
      .filter(
        (
          group,
        ): group is {
          label: string
          options: { value: string; label: string }[]
        } => group !== null,
      )
  }, [settings.chatModels, settings.providers])

  useEffect(() => {
    if (!draftAgent) {
      return
    }
    setModelParamCache((prev) => ({
      temperature: draftAgent.temperature ?? prev.temperature,
      topP: draftAgent.topP ?? prev.topP,
      maxOutputTokens: draftAgent.maxOutputTokens ?? prev.maxOutputTokens,
    }))
  }, [draftAgent])

  useEffect(() => {
    if (!initialAssistantId || draftAgent) {
      return
    }
    const target = assistants.find(
      (assistant) => assistant.id === initialAssistantId,
    )
    if (!target) {
      return
    }
    setDraftAgent(toDraftAgent(target, settings.chatModelId))
    setActiveTab('profile')
  }, [assistants, draftAgent, initialAssistantId, settings.chatModelId])

  const upsertDraft = async () => {
    if (
      !draftAgent ||
      !draftAgent.name.trim() ||
      !draftAgent.systemPrompt.trim()
    ) {
      return
    }

    const normalized: Assistant = {
      ...draftAgent,
      name: draftAgent.name.trim(),
      description: draftAgent.description?.trim(),
      enabledToolNames: normalizeToolSelection(
        draftAgent.enabledToolNames,
        availableTools,
      ),
      updatedAt: Date.now(),
    }

    const exists = assistants.some(
      (assistant) => assistant.id === normalized.id,
    )
    const nextAssistants = exists
      ? assistants.map((assistant) =>
          assistant.id === normalized.id ? normalized : assistant,
        )
      : [...assistants, normalized]

    await setSettings({
      ...settings,
      assistants: nextAssistants,
      currentAssistantId: settings.currentAssistantId ?? normalized.id,
      quickAskAssistantId: settings.quickAskAssistantId ?? normalized.id,
    })
    if (isDirectEntry) {
      onClose()
      return
    }
    setDraftAgent(null)
  }

  const toggleTool = (toolName: string) => {
    if (!draftAgent) {
      return
    }
    const current = new Set(draftAgent.enabledToolNames ?? [])
    if (current.has(toolName)) {
      current.delete(toolName)
    } else {
      current.add(toolName)
    }
    setDraftAgent({
      ...draftAgent,
      enabledToolNames: [...current],
    })
  }

  const setSkillEnabled = (skillId: string, enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current = new Set(draftAgent.enabledSkills ?? [])
    const nextPreferences = {
      ...(draftAgent.skillPreferences ?? {}),
    }

    if (enabled) {
      current.add(skillId)
    } else {
      current.delete(skillId)
    }

    nextPreferences[skillId] = {
      ...(nextPreferences[skillId] ?? {}),
      enabled,
    }

    setDraftAgent({
      ...draftAgent,
      enabledSkills: [...current],
      skillPreferences: nextPreferences,
    })
  }

  const setSkillLoadMode = (
    skillId: string,
    loadMode: AssistantSkillLoadMode,
  ) => {
    if (!draftAgent) {
      return
    }

    const nextPreferences = {
      ...(draftAgent.skillPreferences ?? {}),
      [skillId]: {
        ...(draftAgent.skillPreferences?.[skillId] ?? {}),
        enabled:
          draftAgent.skillPreferences?.[skillId]?.enabled ??
          draftAgent.enabledSkills?.includes(skillId) ??
          true,
        loadMode,
      },
    }

    setDraftAgent({
      ...draftAgent,
      skillPreferences: nextPreferences,
    })
  }

  const localFsServerName = getLocalFileToolServerName()

  const visibleToolGroups = useMemo(() => {
    const groups = new Map<string, { title: string; tools: AgentToolView[] }>()

    availableTools.forEach((tool) => {
      let serverName = localFsServerName
      let toolName = tool.name

      try {
        const parsed = parseToolName(tool.name)
        serverName = parsed.serverName
        toolName = parsed.toolName
      } catch {
        serverName = localFsServerName
        toolName = tool.name
      }

      const isBuiltin = serverName === localFsServerName
      if (isBuiltin && draftAgent?.includeBuiltinTools === false) {
        return
      }

      const key = serverName
      const title = isBuiltin
        ? t('settings.agent.toolsGroupBuiltin', 'Built-in tools')
        : serverName
      const builtinMeta = isBuiltin ? BUILTIN_TOOL_LABEL_KEYS[toolName] : null
      const displayName = builtinMeta
        ? t(builtinMeta.key, builtinMeta.fallback)
        : toolName
      const description = builtinMeta
        ? t(builtinMeta.descKey, builtinMeta.descFallback)
        : tool.description || t('common.none', 'None')
      const group = groups.get(key) ?? { title, tools: [] }
      group.tools.push({
        fullName: tool.name,
        displayName,
        description,
      })
      groups.set(key, group)
    })

    return [...groups.entries()]
      .sort(([a], [b]) => {
        if (a === localFsServerName) return -1
        if (b === localFsServerName) return 1
        return a.localeCompare(b)
      })
      .map(([key, value]) => ({ key, ...value }))
  }, [availableTools, draftAgent?.includeBuiltinTools, localFsServerName, t])

  const visibleToolsCount = useMemo(
    () => visibleToolGroups.reduce((sum, group) => sum + group.tools.length, 0),
    [visibleToolGroups],
  )

  const enabledVisibleToolsCount = useMemo(() => {
    const enabled = new Set(draftAgent?.enabledToolNames ?? [])
    return visibleToolGroups.reduce(
      (sum, group) =>
        sum + group.tools.filter((tool) => enabled.has(tool.fullName)).length,
      0,
    )
  }, [draftAgent?.enabledToolNames, visibleToolGroups])

  const skillEntries = useMemo<LiteSkillEntry[]>(
    () => listLiteSkillEntries(app),
    [app],
  )

  const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
  const disabledSkillIdSet = useMemo(
    () => getDisabledSkillIdSet(disabledSkillIds),
    [disabledSkillIds],
  )

  const skillRows = useMemo(() => {
    return skillEntries.map((skill) => {
      const globallyDisabled = disabledSkillIdSet.has(skill.id)
      const policy = resolveAssistantSkillPolicy({
        assistant: draftAgent,
        skillId: skill.id,
      })
      const enabled = policy.enabled && !globallyDisabled
      return {
        ...skill,
        globallyDisabled,
        enabled,
        loadMode: policy.loadMode,
      }
    })
  }, [disabledSkillIdSet, draftAgent, skillEntries])

  const alwaysSkillRows = useMemo(
    () =>
      skillRows.filter((skill) => skill.enabled && skill.loadMode === 'always'),
    [skillRows],
  )
  const lazySkillRows = useMemo(
    () =>
      skillRows.filter((skill) => skill.enabled && skill.loadMode === 'lazy'),
    [skillRows],
  )

  const resetModelParams = () => {
    if (!draftAgent) {
      return
    }
    setModelParamCache({
      temperature: AGENT_MODEL_DEFAULTS.temperature,
      topP: AGENT_MODEL_DEFAULTS.topP,
      maxOutputTokens: AGENT_MODEL_DEFAULTS.maxOutputTokens,
    })
    setDraftAgent({
      ...draftAgent,
      temperature: AGENT_MODEL_DEFAULTS.temperature,
      topP: AGENT_MODEL_DEFAULTS.topP,
      maxOutputTokens: AGENT_MODEL_DEFAULTS.maxOutputTokens,
    })
  }

  const setTemperatureEnabled = (enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current = draftAgent.temperature ?? modelParamCache.temperature
    setModelParamCache((prev) => ({ ...prev, temperature: current }))
    setDraftAgent({
      ...draftAgent,
      temperature: enabled ? current : undefined,
    })
  }

  const setTopPEnabled = (enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current = draftAgent.topP ?? modelParamCache.topP
    setModelParamCache((prev) => ({ ...prev, topP: current }))
    setDraftAgent({
      ...draftAgent,
      topP: enabled ? current : undefined,
    })
  }

  const setMaxOutputTokensEnabled = (enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current =
      draftAgent.maxOutputTokens ?? modelParamCache.maxOutputTokens
    setModelParamCache((prev) => ({ ...prev, maxOutputTokens: current }))
    setDraftAgent({
      ...draftAgent,
      maxOutputTokens: enabled ? current : undefined,
    })
  }

  return (
    <div
      className={`smtcmp-settings-section smtcmp-agent-editor-panel${
        isDirectEntry ? ' smtcmp-agent-editor-panel--direct' : ''
      }`}
    >
      {draftAgent && (
        <div className="smtcmp-agent-editor-sheet">
          <div className="smtcmp-agent-editor-sheet-header">
            <div>
              <div className="smtcmp-settings-sub-header">
                {draftAgent.name ||
                  t('settings.agent.editorDefaultName', 'New agent')}
              </div>
              <div className="smtcmp-settings-desc">
                {t(
                  'settings.agent.editorIntro',
                  "Configure this agent's capabilities, model, and behavior.",
                )}
              </div>
            </div>
            {!isDirectEntry && (
              <div className="smtcmp-agent-editor-sheet-actions">
                <ObsidianButton
                  text={t('common.cancel', 'Cancel')}
                  onClick={() => setDraftAgent(null)}
                />
                <ObsidianButton
                  text={t('common.save', 'Save')}
                  cta
                  onClick={() => void upsertDraft()}
                />
              </div>
            )}
          </div>

          <div
            className="smtcmp-agent-editor-tabs smtcmp-agent-editor-tabs--glider"
            role="tablist"
            ref={tabsNavRef}
            style={
              {
                '--smtcmp-agent-tab-count': AGENT_EDITOR_TABS.length,
                '--smtcmp-agent-tab-index': activeTabIndex,
              } as React.CSSProperties
            }
          >
            <div
              className="smtcmp-agent-editor-tabs-glider"
              aria-hidden="true"
            />
            {AGENT_EDITOR_TABS.map((tab, index) => {
              const TabIcon = AGENT_EDITOR_TAB_ICONS[tab]
              return (
                <button
                  key={tab}
                  type="button"
                  className={`smtcmp-agent-editor-tab ${activeTab === tab ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                  role="tab"
                  aria-selected={activeTab === tab}
                  ref={(element) => {
                    tabRefs.current[index] = element
                  }}
                >
                  <span
                    className="smtcmp-agent-editor-tab-icon"
                    aria-hidden="true"
                  >
                    <TabIcon size={14} />
                  </span>
                  <span className="smtcmp-agent-editor-tab-label">
                    {
                      {
                        profile: t(
                          'settings.agent.editorTabProfile',
                          'Profile',
                        ),
                        tools: t('settings.agent.editorTabTools', 'Tools'),
                        skills: t('settings.agent.editorTabSkills', 'Skills'),
                        model: t('settings.agent.editorTabModel', 'Model'),
                      }[tab]
                    }
                  </span>
                </button>
              )
            })}
          </div>

          {activeTab === 'profile' && (
            <div className="smtcmp-agent-editor-body">
              <ObsidianSetting
                name={t('settings.agent.editorName', 'Name')}
                desc={t('settings.agent.editorNameDesc', 'Agent display name')}
              >
                <ObsidianTextInput
                  value={draftAgent.name}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, name: value })
                  }
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorDescription', 'Description')}
                desc={t(
                  'settings.agent.editorDescriptionDesc',
                  'Short summary for this agent',
                )}
              >
                <ObsidianTextInput
                  value={draftAgent.description || ''}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, description: value })
                  }
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorIcon', 'Icon')}
                desc={t(
                  'settings.agent.editorIconDesc',
                  'Pick an icon for this agent',
                )}
              >
                <ObsidianButton
                  text={t('settings.agent.editorChooseIcon', 'Choose icon')}
                  onClick={() => {
                    openIconPicker(app, draftAgent.icon, (newIcon) => {
                      setDraftAgent({ ...draftAgent, icon: newIcon })
                    })
                  }}
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorSystemPrompt', 'System prompt')}
                desc={t(
                  'settings.agent.editorSystemPromptDesc',
                  'Primary behavior instruction for this agent',
                )}
                className="smtcmp-settings-textarea-header"
              />
              <ObsidianSetting className="smtcmp-settings-textarea">
                <ObsidianTextArea
                  value={draftAgent.systemPrompt}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, systemPrompt: value })
                  }
                />
              </ObsidianSetting>
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="smtcmp-agent-editor-body">
              <ObsidianSetting
                name={t('settings.agent.editorEnableTools', 'Enable tools')}
                desc={t(
                  'settings.agent.editorEnableToolsDesc',
                  'Allow this agent to call tools',
                )}
              >
                <ObsidianToggle
                  value={Boolean(draftAgent.enableTools)}
                  onChange={(value) =>
                    setDraftAgent({
                      ...draftAgent,
                      enableTools: value,
                    })
                  }
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t(
                  'settings.agent.editorIncludeBuiltinTools',
                  'Include built-in tools',
                )}
                desc={t(
                  'settings.agent.editorIncludeBuiltinToolsDesc',
                  'Allow local vault file tools for this agent',
                )}
              >
                <ObsidianToggle
                  value={Boolean(draftAgent.includeBuiltinTools)}
                  onChange={(value) =>
                    setDraftAgent({
                      ...draftAgent,
                      includeBuiltinTools: value,
                    })
                  }
                />
              </ObsidianSetting>
              <div
                className={`smtcmp-agent-tools-panel${
                  draftAgent.enableTools ? '' : ' is-disabled'
                }`}
              >
                <div className="smtcmp-agent-tools-panel-head">
                  <div className="smtcmp-agent-tools-panel-title">
                    {t('settings.agent.tools', 'Tools')}
                  </div>
                  <div className="smtcmp-agent-tools-panel-count">
                    {`${enabledVisibleToolsCount} / ${visibleToolsCount} ${t(
                      'settings.agent.toolsActive',
                      'active',
                    )}`}
                  </div>
                </div>

                {visibleToolGroups.map((group) => (
                  <div key={group.key} className="smtcmp-agent-tool-group">
                    <div className="smtcmp-agent-tool-group-title">
                      {group.title}
                    </div>
                    <div className="smtcmp-agent-tool-list">
                      {group.tools.map((tool) => {
                        const selected = draftAgent.enabledToolNames?.includes(
                          tool.fullName,
                        )

                        return (
                          <div
                            key={tool.fullName}
                            className="smtcmp-agent-tool-row"
                          >
                            <div className="smtcmp-agent-tool-main">
                              <div className="smtcmp-agent-tool-name smtcmp-agent-tool-name--mono">
                                {tool.displayName}
                              </div>
                              <div className="smtcmp-agent-tool-source smtcmp-agent-tool-source--preview">
                                {tool.description}
                              </div>
                            </div>
                            <div className="smtcmp-agent-tool-toggle">
                              <ObsidianToggle
                                value={Boolean(selected)}
                                onChange={() => toggleTool(tool.fullName)}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}

                {visibleToolsCount === 0 && (
                  <div className="smtcmp-agent-tools-empty">
                    {t('settings.agent.noTools', 'No tools available')}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="smtcmp-agent-editor-body">
              <div className="smtcmp-agent-tools-panel">
                <div className="smtcmp-agent-tools-panel-head">
                  <div className="smtcmp-agent-tools-panel-title">
                    {t('settings.agent.skills', 'Skills')}
                  </div>
                  <div className="smtcmp-agent-tools-panel-count">
                    {t(
                      'settings.agent.editorSkillsCountWithEnabled',
                      '{count} skills (enabled {enabled})',
                    )
                      .replace('{count}', String(skillRows.length))
                      .replace(
                        '{enabled}',
                        String(
                          skillRows.filter((skill) => skill.enabled).length,
                        ),
                      )}
                  </div>
                </div>

                <div className="smtcmp-agent-skill-summary-row">
                  <span className="smtcmp-agent-chip">
                    {t('settings.agent.skillLoadAlways', 'Full inject')}:{' '}
                    {alwaysSkillRows.length}
                  </span>
                  <span className="smtcmp-agent-chip">
                    {t('settings.agent.skillLoadLazy', 'On demand')}:{' '}
                    {lazySkillRows.length}
                  </span>
                </div>

                {skillRows.length > 0 ? (
                  <div className="smtcmp-agent-tool-list">
                    {skillRows.map((skill) => {
                      const disabledByGlobal = skill.globallyDisabled
                      return (
                        <div key={skill.id} className="smtcmp-agent-tool-row">
                          <div className="smtcmp-agent-tool-main">
                            <div className="smtcmp-agent-tool-name">
                              {skill.name}
                            </div>
                            <div className="smtcmp-agent-tool-source smtcmp-agent-tool-source--preview">
                              {skill.description}
                            </div>
                            <div className="smtcmp-agent-skill-meta">
                              <span className="smtcmp-agent-chip">
                                id: {skill.id}
                              </span>
                              <span className="smtcmp-agent-chip">
                                {skill.path}
                              </span>
                              {disabledByGlobal && (
                                <span className="smtcmp-agent-chip">
                                  {t(
                                    'settings.agent.skillDisabledGlobally',
                                    'Disabled globally',
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="smtcmp-agent-skill-controls">
                            <ObsidianToggle
                              value={skill.enabled}
                              onChange={(value) => {
                                if (disabledByGlobal) {
                                  return
                                }
                                setSkillEnabled(skill.id, value)
                              }}
                            />
                            <select
                              value={skill.loadMode}
                              disabled={!skill.enabled || disabledByGlobal}
                              onChange={(event) =>
                                setSkillLoadMode(
                                  skill.id,
                                  event.target.value as AssistantSkillLoadMode,
                                )
                              }
                            >
                              <option value="always">
                                {t(
                                  'settings.agent.skillLoadAlways',
                                  'Full inject',
                                )}
                              </option>
                              <option value="lazy">
                                {t('settings.agent.skillLoadLazy', 'On demand')}
                              </option>
                            </select>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="smtcmp-agent-tools-empty">
                    {t(
                      'settings.agent.skillsEmptyHint',
                      'No skills found. Create markdown skills under YOLO/skills.',
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'model' && (
            <div className="smtcmp-agent-editor-body">
              <div className="smtcmp-agent-model-setting-row">
                <div className="smtcmp-agent-model-setting-info">
                  <div className="smtcmp-agent-model-setting-title">
                    {t('settings.agent.editorModel', 'Model')}
                  </div>
                  <div className="smtcmp-agent-model-setting-desc">
                    {t(
                      'settings.agent.editorModelDesc',
                      'Select the model used by this agent',
                    )}
                  </div>
                </div>
                <div className="smtcmp-agent-model-select-wrap">
                  <SimpleSelect
                    value={draftAgent.modelId || settings.chatModelId}
                    groupedOptions={agentModelOptionGroups}
                    align="end"
                    side="bottom"
                    sideOffset={6}
                    placeholder={t('common.select', 'Select')}
                    contentClassName="smtcmp-agent-model-select-content"
                    onChange={(value: string) =>
                      setDraftAgent({
                        ...draftAgent,
                        modelId: value,
                      })
                    }
                  />
                </div>
              </div>

              <div className="smtcmp-agent-tools-panel smtcmp-agent-model-panel">
                <div className="smtcmp-agent-tools-panel-head smtcmp-agent-model-panel-head">
                  <div className="smtcmp-agent-tools-panel-title">
                    {t(
                      'settings.agent.editorModelSampling',
                      'Sampling parameters',
                    )}
                  </div>
                  <button
                    type="button"
                    className="smtcmp-agent-model-reset"
                    onClick={resetModelParams}
                  >
                    {t(
                      'settings.agent.editorModelResetDefaults',
                      'Restore defaults',
                    )}
                  </button>
                </div>

                <div className="smtcmp-agent-model-controls">
                  <div
                    className={`smtcmp-agent-model-control${
                      draftAgent.temperature === undefined ? ' is-disabled' : ''
                    }`}
                  >
                    <div className="smtcmp-agent-model-control-top">
                      <div className="smtcmp-agent-model-control-meta">
                        <div className="smtcmp-agent-model-control-label">
                          {t('settings.agent.editorTemperature', 'Temperature')}
                        </div>
                      </div>
                      <div className="smtcmp-agent-model-control-actions">
                        <ObsidianToggle
                          value={draftAgent.temperature !== undefined}
                          onChange={setTemperatureEnabled}
                        />
                      </div>
                    </div>
                    {draftAgent.temperature !== undefined && (
                      <div className="smtcmp-agent-model-control-adjust">
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.01}
                          value={
                            draftAgent.temperature ??
                            modelParamCache.temperature
                          }
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampTemperature(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              temperature: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              temperature: clamped,
                            })
                          }}
                        />
                        <input
                          type="number"
                          className="smtcmp-agent-model-number"
                          min={0}
                          max={2}
                          step={0.1}
                          value={
                            draftAgent.temperature ??
                            modelParamCache.temperature
                          }
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampTemperature(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              temperature: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              temperature: clamped,
                            })
                          }}
                        />
                      </div>
                    )}
                  </div>

                  <div
                    className={`smtcmp-agent-model-control${
                      draftAgent.topP === undefined ? ' is-disabled' : ''
                    }`}
                  >
                    <div className="smtcmp-agent-model-control-top">
                      <div className="smtcmp-agent-model-control-meta">
                        <div className="smtcmp-agent-model-control-label">
                          {t('settings.agent.editorTopP', 'Top P')}
                        </div>
                      </div>
                      <div className="smtcmp-agent-model-control-actions">
                        <ObsidianToggle
                          value={draftAgent.topP !== undefined}
                          onChange={setTopPEnabled}
                        />
                      </div>
                    </div>
                    {draftAgent.topP !== undefined && (
                      <div className="smtcmp-agent-model-control-adjust">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={draftAgent.topP ?? modelParamCache.topP}
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampTopP(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              topP: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              topP: clamped,
                            })
                          }}
                        />
                        <input
                          type="number"
                          className="smtcmp-agent-model-number"
                          min={0}
                          max={1}
                          step={0.01}
                          value={draftAgent.topP ?? modelParamCache.topP}
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampTopP(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              topP: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              topP: clamped,
                            })
                          }}
                        />
                      </div>
                    )}
                  </div>

                  <div
                    className={`smtcmp-agent-model-control${
                      draftAgent.maxOutputTokens === undefined
                        ? ' is-disabled'
                        : ''
                    }`}
                  >
                    <div className="smtcmp-agent-model-control-top">
                      <div className="smtcmp-agent-model-control-meta">
                        <div className="smtcmp-agent-model-control-label">
                          {t(
                            'settings.agent.editorMaxOutputTokens',
                            'Max output tokens',
                          )}
                        </div>
                      </div>
                      <div className="smtcmp-agent-model-control-actions">
                        <ObsidianToggle
                          value={draftAgent.maxOutputTokens !== undefined}
                          onChange={setMaxOutputTokensEnabled}
                        />
                      </div>
                    </div>
                    {draftAgent.maxOutputTokens !== undefined && (
                      <div className="smtcmp-agent-model-control-adjust">
                        <input
                          type="range"
                          min={256}
                          max={32768}
                          step={256}
                          value={Math.min(
                            32768,
                            Math.max(
                              256,
                              draftAgent.maxOutputTokens ??
                                modelParamCache.maxOutputTokens,
                            ),
                          )}
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampMaxOutputTokens(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              maxOutputTokens: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              maxOutputTokens: clamped,
                            })
                          }}
                        />
                        <input
                          type="number"
                          className="smtcmp-agent-model-number"
                          min={1}
                          step={1}
                          value={
                            draftAgent.maxOutputTokens ??
                            modelParamCache.maxOutputTokens
                          }
                          onChange={(event) => {
                            const next = Number(event.currentTarget.value)
                            if (!Number.isFinite(next)) {
                              return
                            }
                            const clamped = clampMaxOutputTokens(next)
                            setModelParamCache((prev) => ({
                              ...prev,
                              maxOutputTokens: clamped,
                            }))
                            setDraftAgent({
                              ...draftAgent,
                              maxOutputTokens: clamped,
                            })
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {isDirectEntry && (
            <div className="smtcmp-agent-editor-direct-footer">
              <div className="smtcmp-agent-editor-direct-footer-actions">
                <ObsidianButton
                  text={t('common.cancel', 'Cancel')}
                  onClick={onClose}
                />
                <ObsidianButton
                  text={t('common.save', 'Save')}
                  cta
                  onClick={() => void upsertDraft()}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
