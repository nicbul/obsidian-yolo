import { App, Notice, normalizePath } from 'obsidian'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { listLiteSkillEntries } from '../../../core/skills/liteSkills'
import {
  YOLO_SKILLS_DIR,
  YOLO_SKILLS_INDEX_TEMPLATE,
  YOLO_SKILL_CREATOR_TEMPLATE,
} from '../../../core/skills/templates'
import SmartComposerPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'

type AgentSkillsModalProps = {
  app: App
  plugin: SmartComposerPlugin
}

export class AgentSkillsModal extends ReactModal<AgentSkillsModalProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app,
      Component: AgentSkillsModalWrapper,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.agent.manageSkills', 'Manage skills'),
      },
      plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
  }
}

function AgentSkillsModalWrapper({
  app,
  plugin,
  onClose: _onClose,
}: AgentSkillsModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <AgentSkillsModalContent app={app} plugin={plugin} />
    </SettingsProvider>
  )
}

function AgentSkillsModalContent({
  app,
  plugin: _plugin,
}: {
  app: App
  plugin: SmartComposerPlugin
}) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const [refreshTick, setRefreshTick] = useState(0)

  const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
  const disabledSkillIdSet = useMemo(
    () => new Set(disabledSkillIds),
    [disabledSkillIds],
  )

  const skills = useMemo(() => {
    void refreshTick
    return listLiteSkillEntries(app)
  }, [app, refreshTick])

  const handleToggleSkill = (skillId: string, enabled: boolean) => {
    const current = new Set(settings.skills?.disabledSkillIds ?? [])
    if (enabled) {
      current.delete(skillId)
    } else {
      current.add(skillId)
    }

    void setSettings({
      ...settings,
      skills: {
        ...(settings.skills ?? { disabledSkillIds: [] }),
        disabledSkillIds: [...current],
      },
    })
  }

  const handleInitializeSkillsSystem = async () => {
    const skillsDir = normalizePath(YOLO_SKILLS_DIR)
    const indexPath = normalizePath(`${skillsDir}/Skills.md`)
    const skillCreatorPath = normalizePath(`${skillsDir}/skill-creator.md`)

    try {
      const maybeFolder = app.vault.getAbstractFileByPath(skillsDir)
      if (!maybeFolder) {
        await app.vault.createFolder(skillsDir)
      }

      if (!app.vault.getAbstractFileByPath(indexPath)) {
        await app.vault.create(indexPath, YOLO_SKILLS_INDEX_TEMPLATE)
      }

      if (!app.vault.getAbstractFileByPath(skillCreatorPath)) {
        await app.vault.create(skillCreatorPath, YOLO_SKILL_CREATOR_TEMPLATE)
      }

      setRefreshTick((value) => value + 1)
      new Notice(
        t(
          'settings.agent.skillsTemplateCreated',
          'Skills system initialized in YOLO/skills.',
        ),
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create skill files.'
      new Notice(message)
    }
  }

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-desc smtcmp-settings-callout">
        {t(
          'settings.agent.skillsGlobalDesc',
          'Skills are discovered from YOLO/skills/**/*.md (excluding Skills.md). Disable a skill here to block it for all agents.',
        )}
      </div>

      <div className="smtcmp-agent-skills-toolbar">
        <div className="smtcmp-settings-desc">
          {t(
            'settings.agent.skillsSourcePath',
            'Path: YOLO/skills/**/*.md (excluding Skills.md)',
          )}
        </div>
        <div className="smtcmp-agent-skills-toolbar-actions">
          <ObsidianButton
            text={t(
              'settings.agent.createSkillTemplates',
              'Initialize Skills system',
            )}
            onClick={() => void handleInitializeSkillsSystem()}
          />
          <ObsidianButton
            text={t('settings.agent.refreshSkills', 'Refresh')}
            onClick={() => setRefreshTick((value) => value + 1)}
          />
        </div>
      </div>

      <div className="smtcmp-agent-tools-panel smtcmp-agent-skills-modal-panel">
        <div className="smtcmp-agent-tools-panel-head">
          <div className="smtcmp-agent-tools-panel-title">
            {t('settings.agent.skills', 'Skills')}
          </div>
          <div className="smtcmp-agent-tools-panel-count">
            {t(
              'settings.agent.skillsCountWithEnabled',
              '{count} skills (enabled {enabled})',
            )
              .replace('{count}', String(skills.length))
              .replace(
                '{enabled}',
                String(
                  skills.filter((skill) => !disabledSkillIdSet.has(skill.id))
                    .length,
                ),
              )}
          </div>
        </div>

        {skills.length > 0 ? (
          <div className="smtcmp-agent-tool-list">
            {skills.map((skill) => {
              const enabled = !disabledSkillIdSet.has(skill.id)
              return (
                <div key={skill.id} className="smtcmp-agent-tool-row">
                  <div className="smtcmp-agent-tool-main">
                    <div className="smtcmp-agent-tool-name">{skill.name}</div>
                    <div className="smtcmp-agent-tool-source smtcmp-agent-tool-source--preview">
                      {skill.description}
                    </div>
                    <div className="smtcmp-agent-skill-meta">
                      <span className="smtcmp-agent-chip">id: {skill.id}</span>
                      <span className="smtcmp-agent-chip">{skill.path}</span>
                    </div>
                  </div>
                  <div className="smtcmp-agent-tool-toggle">
                    <ObsidianToggle
                      value={enabled}
                      onChange={(value) => handleToggleSkill(skill.id, value)}
                    />
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
  )
}
