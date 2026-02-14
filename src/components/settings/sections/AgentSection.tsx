import { BookOpen, Bot, Cpu, Wrench } from 'lucide-react'
import { App } from 'obsidian'
import React from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { Assistant } from '../../../types/assistant.types'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { AssistantsModal } from '../modals/AssistantsModal'

type AgentSectionProps = {
  app: App
}

const DEMO_SKILLS = [
  'Obsidian Markdown Rules',
  'Link-First Knowledge Mapping',
  'Safe File Operations',
  'Architectural Thinking',
]

const TOOL_BADGES = ['Read Vault', 'Write Vault', 'Network', 'Commands']

export function AgentSection({ app }: AgentSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const plugin = usePlugin()
  const assistants = settings.assistants || []

  const handleOpenAssistantsModal = () => {
    const modal = new AssistantsModal(app, plugin)
    modal.open()
  }

  const handleDuplicateAssistant = async (assistant: Assistant) => {
    const copied: Assistant = {
      ...assistant,
      id: crypto.randomUUID(),
      name: `${assistant.name}${t('settings.agent.copySuffix', ' (copy)')}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await setSettings({
      ...settings,
      assistants: [...assistants, copied],
    })
  }

  const handleDeleteAssistant = (assistant: Assistant) => {
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
          (a) => a.id !== assistant.id,
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
      })().catch((error: unknown) => {
        console.error('Failed to delete agent', error)
      })
    }

    modal.open()
  }

  const skillsCountLabel = t(
    'settings.agent.skillsCount',
    '{count} skills',
  ).replace('{count}', String(DEMO_SKILLS.length))

  const toolsCountLabel = t(
    'settings.agent.toolsCount',
    '{count} tools',
  ).replace('{count}', String(TOOL_BADGES.length))

  const mcpCountLabel = t(
    'settings.agent.mcpServerCount',
    '{count} MCP servers connected',
  ).replace('{count}', String(settings.mcp.servers.length))

  return (
    <div className="smtcmp-settings-section smtcmp-agent-section">
      <div className="smtcmp-settings-header">
        {t('settings.agent.title', 'Agent')}
      </div>
      <div className="smtcmp-settings-desc smtcmp-agent-intro">
        {t(
          'settings.agent.desc',
          'Manage global capabilities and configure your agents.',
        )}
      </div>

      <section className="smtcmp-agent-block">
        <div className="smtcmp-agent-block-head">
          <div className="smtcmp-settings-sub-header">
            {t('settings.agent.globalCapabilities', 'Global capabilities')}
          </div>
          <div className="smtcmp-settings-desc">{mcpCountLabel}</div>
        </div>

        <div className="smtcmp-agent-cap-grid">
          <article className="smtcmp-agent-cap-card">
            <div className="smtcmp-agent-cap-title">
              <Wrench size={14} />
              <span>{t('settings.agent.tools', 'Tools')}</span>
            </div>
            <div className="smtcmp-agent-cap-count">{toolsCountLabel}</div>
            <div className="smtcmp-agent-cap-tags">
              {TOOL_BADGES.map((name) => (
                <span key={name} className="smtcmp-agent-chip">
                  {name}
                </span>
              ))}
            </div>
          </article>

          <article className="smtcmp-agent-cap-card">
            <div className="smtcmp-agent-cap-title">
              <BookOpen size={14} />
              <span>{t('settings.agent.skills', 'Skills')}</span>
            </div>
            <div className="smtcmp-agent-cap-count">{skillsCountLabel}</div>
            <div className="smtcmp-agent-cap-tags">
              {DEMO_SKILLS.map((name) => (
                <span key={name} className="smtcmp-agent-chip">
                  {name}
                </span>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="smtcmp-agent-block">
        <div className="smtcmp-agent-block-head smtcmp-agent-block-head--row">
          <div>
            <div className="smtcmp-settings-sub-header">
              {t('settings.agent.agents', 'Agents')}
            </div>
            <div className="smtcmp-settings-desc">
              {t(
                'settings.agent.agentsDesc',
                'Click Configure to edit each agent profile and prompt.',
              )}
            </div>
          </div>
          <ObsidianButton
            text={t('settings.agent.configureAgents', 'Configure')}
            onClick={handleOpenAssistantsModal}
            cta
          />
        </div>

        {assistants.length === 0 ? (
          <div className="smtcmp-agent-empty">
            <Bot size={16} />
            <span>
              {t('settings.agent.noAgents', 'No agents configured yet')}
            </span>
            <ObsidianButton
              text={t('settings.agent.newAgent', 'New agent')}
              icon="plus"
              onClick={handleOpenAssistantsModal}
            />
          </div>
        ) : (
          <div className="smtcmp-agent-grid">
            {assistants.map((assistant) => (
              <article key={assistant.id} className="smtcmp-agent-card">
                <div className="smtcmp-agent-card-top">
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
                    {assistant.description && (
                      <div className="smtcmp-agent-desc">
                        {assistant.description}
                      </div>
                    )}
                  </div>
                </div>

                <div className="smtcmp-agent-meta-row">
                  <span className="smtcmp-agent-meta-item">
                    <Cpu size={12} />
                    {settings.chatModelId}
                  </span>
                  <span className="smtcmp-agent-meta-item">
                    <Wrench size={12} />
                    {toolsCountLabel}
                  </span>
                </div>

                <div className="smtcmp-agent-actions">
                  <ObsidianButton
                    text={t('common.edit')}
                    onClick={handleOpenAssistantsModal}
                  />
                  <ObsidianButton
                    text={t('settings.agent.duplicate', 'Duplicate')}
                    onClick={() => {
                      void handleDuplicateAssistant(assistant)
                    }}
                  />
                  <ObsidianButton
                    text={t('common.delete')}
                    warning
                    onClick={() => handleDeleteAssistant(assistant)}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
