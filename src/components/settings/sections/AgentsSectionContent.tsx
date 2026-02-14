import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  BookOpen,
  Copy,
  Cpu,
  MoreHorizontal,
  Plus,
  Trash2,
  Wrench,
} from 'lucide-react'
import { App } from 'obsidian'
import { useEffect, useMemo, useState } from 'react'

import { AGENT_SKILLS } from '../../../constants/agent-profile'
import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { AgentPersona, Assistant } from '../../../types/assistant.types'
import { McpTool } from '../../../types/mcp.types'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { openIconPicker } from '../assistants/AssistantIconPicker'

type AgentsSectionContentProps = {
  app: App
  onClose: () => void
}

type AgentEditorTab = 'profile' | 'tools' | 'skills' | 'model'

const DEFAULT_PERSONA: AgentPersona = 'balanced'

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
    temperature: 0.7,
    topP: 0.9,
    maxOutputTokens: 4096,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function cloneAgent(agent: Assistant, suffix: string): Assistant {
  return {
    ...agent,
    id: crypto.randomUUID(),
    name: `${agent.name}${suffix}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
}: AgentsSectionContentProps) {
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const assistants = settings.assistants || []
  const [draftAgent, setDraftAgent] = useState<Assistant | null>(null)
  const [activeTab, setActiveTab] = useState<AgentEditorTab>('profile')
  const [availableTools, setAvailableTools] = useState<McpTool[]>([])

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

  const selectedModelLabel = useMemo(() => {
    if (!draftAgent?.modelId) {
      return settings.chatModelId
    }
    const model = settings.chatModels.find(
      (item) => item.id === draftAgent.modelId,
    )
    return model?.name || draftAgent.modelId
  }, [draftAgent?.modelId, settings.chatModelId, settings.chatModels])

  const openCreate = () => {
    const draft = createNewAgent(settings.chatModelId)
    draft.name = t('settings.agent.editorDefaultName', 'New agent')
    setDraftAgent(draft)
    setActiveTab('profile')
  }

  const openEdit = (assistant: Assistant) => {
    setDraftAgent({
      ...assistant,
      persona: assistant.persona ?? DEFAULT_PERSONA,
      modelId: assistant.modelId ?? settings.chatModelId,
      enabledToolNames: assistant.enabledToolNames ?? [],
      enabledSkills: assistant.enabledSkills ?? [],
      enableTools: assistant.enableTools ?? true,
      includeBuiltinTools: assistant.includeBuiltinTools ?? true,
      temperature: assistant.temperature ?? 0.7,
      topP: assistant.topP ?? 0.9,
      maxOutputTokens: assistant.maxOutputTokens ?? 4096,
    })
    setActiveTab('profile')
  }

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
    setDraftAgent(null)
  }

  const handleDelete = (assistant: Assistant) => {
    let confirmed = false
    const modal = new ConfirmModal(app, {
      title: t('settings.agent.deleteConfirmTitle', 'Confirm delete agent'),
      message: `${t('settings.agent.deleteConfirmMessagePrefix', 'Are you sure you want to delete agent')} "${assistant.name}"${t('settings.agent.deleteConfirmMessageSuffix', '? This action cannot be undone.')}`,
      ctaText: t('common.delete'),
      onConfirm: () => {
        confirmed = true
      },
    })

    modal.onClose = () => {
      if (!confirmed) {
        return
      }
      void (async () => {
        const updatedAssistants = assistants.filter(
          (item) => item.id !== assistant.id,
        )
        await setSettings({
          ...settings,
          assistants: updatedAssistants,
          currentAssistantId:
            settings.currentAssistantId === assistant.id
              ? updatedAssistants[0]?.id
              : settings.currentAssistantId,
          quickAskAssistantId:
            settings.quickAskAssistantId === assistant.id
              ? updatedAssistants[0]?.id
              : settings.quickAskAssistantId,
        })
        if (draftAgent?.id === assistant.id) {
          setDraftAgent(null)
        }
      })().catch((error: unknown) => {
        console.error('Failed to delete agent', error)
      })
    }

    modal.open()
  }

  const handleDuplicate = async (assistant: Assistant) => {
    await setSettings({
      ...settings,
      assistants: [
        ...assistants,
        cloneAgent(assistant, t('settings.agent.copySuffix', ' (copy)')),
      ],
    })
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

  const toggleSkill = (skillId: string) => {
    if (!draftAgent) {
      return
    }
    const current = new Set(draftAgent.enabledSkills ?? [])
    if (current.has(skillId)) {
      current.delete(skillId)
    } else {
      current.add(skillId)
    }
    setDraftAgent({
      ...draftAgent,
      enabledSkills: [...current],
    })
  }

  const toolsEnabledCount = (assistant: Assistant): number =>
    assistant.enableTools ? (assistant.enabledToolNames?.length ?? 0) : 0

  const skillsEnabledCount = (assistant: Assistant): number =>
    assistant.enabledSkills?.length ?? 0

  const localFsServerName = getLocalFileToolServerName()

  return (
    <div className="smtcmp-settings-section smtcmp-agent-editor-panel">
      <div className="smtcmp-agent-modal-header-row">
        <div className="smtcmp-settings-desc">
          {t(
            'settings.agent.agentsDesc',
            'Click Configure to edit each agent profile and prompt.',
          )}
        </div>
        <div className="smtcmp-agent-modal-header-actions">
          <ObsidianButton
            text={t('settings.agent.newAgent', 'New agent')}
            icon="plus"
            cta
            onClick={openCreate}
          />
          <ObsidianButton text={t('common.close', 'Close')} onClick={onClose} />
        </div>
      </div>

      <div className="smtcmp-agent-grid">
        {assistants.map((assistant) => (
          <article
            key={assistant.id}
            className="smtcmp-agent-card smtcmp-agent-card--clickable"
            role="button"
            tabIndex={0}
            onClick={() => openEdit(assistant)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openEdit(assistant)
              }
            }}
          >
            <div className="smtcmp-agent-card-top">
              <div className="smtcmp-agent-card-top-main">
                <div className="smtcmp-agent-avatar">
                  {renderAssistantIcon(assistant.icon, 16)}
                </div>
                <div className="smtcmp-agent-main">
                  <div className="smtcmp-agent-name-row">
                    <div className="smtcmp-agent-name">{assistant.name}</div>
                    {settings.currentAssistantId === assistant.id && (
                      <span className="smtcmp-agent-current-badge">
                        {t('settings.agent.current', 'Current')}
                      </span>
                    )}
                  </div>
                  <div className="smtcmp-agent-persona-chip">
                    {getPersonaLabel(assistant.persona)}
                  </div>
                  {assistant.description && (
                    <div className="smtcmp-agent-desc">
                      {assistant.description}
                    </div>
                  )}
                </div>
              </div>

              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  className="smtcmp-agent-card-menu-trigger"
                  aria-label={t('common.actions', 'Actions')}
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontal size={14} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="smtcmp-agent-card-menu-popover"
                    align="end"
                    sideOffset={8}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <ul className="smtcmp-agent-card-menu-list">
                      <DropdownMenu.Item
                        asChild
                        onSelect={() => {
                          void handleDuplicate(assistant)
                        }}
                      >
                        <li className="smtcmp-agent-card-menu-item">
                          <span className="smtcmp-agent-card-menu-icon">
                            <Copy size={16} />
                          </span>
                          {t('settings.agent.duplicate', 'Duplicate')}
                        </li>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        asChild
                        onSelect={() => handleDelete(assistant)}
                      >
                        <li className="smtcmp-agent-card-menu-item smtcmp-agent-card-menu-danger">
                          <span className="smtcmp-agent-card-menu-icon">
                            <Trash2 size={16} />
                          </span>
                          {t('common.delete')}
                        </li>
                      </DropdownMenu.Item>
                    </ul>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>

            <div className="smtcmp-agent-meta-row">
              <span className="smtcmp-agent-meta-item">
                <Cpu size={12} />
                {assistant.modelId || settings.chatModelId}
              </span>
              <span className="smtcmp-agent-meta-item">
                <Wrench size={12} />
                {t('settings.agent.editorToolsCount', '{count} tools').replace(
                  '{count}',
                  String(toolsEnabledCount(assistant)),
                )}
              </span>
              <span className="smtcmp-agent-meta-item">
                <BookOpen size={12} />
                {t(
                  'settings.agent.editorSkillsCount',
                  '{count} skills',
                ).replace('{count}', String(skillsEnabledCount(assistant)))}
              </span>
            </div>
          </article>
        ))}
      </div>

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
          </div>

          <div className="smtcmp-agent-editor-tabs">
            {(['profile', 'tools', 'skills', 'model'] as AgentEditorTab[]).map(
              (tab) => (
                <button
                  key={tab}
                  className={`smtcmp-agent-editor-tab ${activeTab === tab ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {
                    {
                      profile: t('settings.agent.editorTabProfile', 'Profile'),
                      tools: t('settings.agent.editorTabTools', 'Tools'),
                      skills: t('settings.agent.editorTabSkills', 'Skills'),
                      model: t('settings.agent.editorTabModel', 'Model'),
                    }[tab]
                  }
                </button>
              ),
            )}
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
                <ObsidianButton
                  text={
                    draftAgent.enableTools
                      ? t('settings.agent.editorEnabled', 'Enabled')
                      : t('settings.agent.editorDisabled', 'Disabled')
                  }
                  onClick={() =>
                    setDraftAgent({
                      ...draftAgent,
                      enableTools: !draftAgent.enableTools,
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
                <ObsidianButton
                  text={
                    draftAgent.includeBuiltinTools
                      ? t('settings.agent.editorEnabled', 'Enabled')
                      : t('settings.agent.editorDisabled', 'Disabled')
                  }
                  onClick={() =>
                    setDraftAgent({
                      ...draftAgent,
                      includeBuiltinTools: !draftAgent.includeBuiltinTools,
                    })
                  }
                />
              </ObsidianSetting>
              <div className="smtcmp-agent-tool-list">
                {availableTools.map((tool) => {
                  const isBuiltin = tool.name.startsWith(
                    `${localFsServerName}__`,
                  )
                  if (isBuiltin && draftAgent.includeBuiltinTools === false) {
                    return null
                  }
                  const selected = draftAgent.enabledToolNames?.includes(
                    tool.name,
                  )
                  return (
                    <div key={tool.name} className="smtcmp-agent-tool-row">
                      <div className="smtcmp-agent-tool-main">
                        <div className="smtcmp-agent-tool-name smtcmp-agent-tool-name--mono">
                          {tool.name}
                        </div>
                        <div className="smtcmp-agent-tool-source">
                          {tool.description}
                        </div>
                      </div>
                      <ObsidianButton
                        text={
                          selected
                            ? t('settings.agent.editorEnabled', 'Enabled')
                            : t('settings.agent.editorDisabled', 'Disabled')
                        }
                        onClick={() => toggleTool(tool.name)}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="smtcmp-agent-editor-body">
              {AGENT_SKILLS.map((skill) => {
                const enabled = draftAgent.enabledSkills?.includes(skill.id)
                return (
                  <div key={skill.id} className="smtcmp-agent-tool-row">
                    <div className="smtcmp-agent-tool-main">
                      <div className="smtcmp-agent-tool-name">{skill.name}</div>
                      <div className="smtcmp-agent-tool-source">
                        {skill.description}
                      </div>
                    </div>
                    <ObsidianButton
                      text={
                        enabled
                          ? t('settings.agent.editorEnabled', 'Enabled')
                          : t('settings.agent.editorDisabled', 'Disabled')
                      }
                      onClick={() => toggleSkill(skill.id)}
                    />
                  </div>
                )
              })}
            </div>
          )}

          {activeTab === 'model' && (
            <div className="smtcmp-agent-editor-body">
              <ObsidianSetting
                name={t('settings.agent.editorModel', 'Model')}
                desc={t(
                  'settings.agent.editorModelCurrent',
                  'Current: {model}',
                ).replace('{model}', selectedModelLabel)}
              >
                <select
                  value={draftAgent.modelId || settings.chatModelId}
                  onChange={(event) =>
                    setDraftAgent({
                      ...draftAgent,
                      modelId: event.target.value,
                    })
                  }
                >
                  {settings.chatModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorTemperature', 'Temperature')}
                desc={t('settings.agent.editorTemperatureDesc', '0.0 - 2.0')}
              >
                <ObsidianTextInput
                  value={String(draftAgent.temperature ?? 0.7)}
                  onChange={(value) => {
                    const next = Number(value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    setDraftAgent({
                      ...draftAgent,
                      temperature: Math.min(2, Math.max(0, next)),
                    })
                  }}
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorTopP', 'Top P')}
                desc={t('settings.agent.editorTopPDesc', '0.0 - 1.0')}
              >
                <ObsidianTextInput
                  value={String(draftAgent.topP ?? 0.9)}
                  onChange={(value) => {
                    const next = Number(value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    setDraftAgent({
                      ...draftAgent,
                      topP: Math.min(1, Math.max(0, next)),
                    })
                  }}
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t(
                  'settings.agent.editorMaxOutputTokens',
                  'Max output tokens',
                )}
                desc={t(
                  'settings.agent.editorMaxOutputTokensDesc',
                  'Maximum generated tokens',
                )}
              >
                <ObsidianTextInput
                  value={String(draftAgent.maxOutputTokens ?? 4096)}
                  onChange={(value) => {
                    const next = Number(value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    setDraftAgent({
                      ...draftAgent,
                      maxOutputTokens: Math.max(1, Math.floor(next)),
                    })
                  }}
                />
              </ObsidianSetting>
            </div>
          )}
        </div>
      )}

      {assistants.length === 0 && (
        <div className="smtcmp-agent-empty">
          <Plus size={16} />
          <span>
            {t('settings.agent.noAgents', 'No agents configured yet')}
          </span>
        </div>
      )}
    </div>
  )
}
const getPersonaLabel = (persona?: string): string => {
  const value = (persona || 'balanced').trim()
  if (!value) {
    return 'Balanced'
  }
  return value.charAt(0).toUpperCase() + value.slice(1)
}
