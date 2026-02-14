import { App } from 'obsidian'
import { useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { McpManager } from '../../../core/mcp/mcpManager'
import SmartComposerPlugin from '../../../main'
import { McpServerState, McpServerStatus } from '../../../types/mcp.types'
import { ReactModal } from '../../common/ReactModal'
import { ObsidianToggle } from '../../common/ObsidianToggle'

type AgentToolsModalProps = {
  plugin: SmartComposerPlugin
}

const BUILTIN_TOOLS = ['Read Vault', 'Write Vault', 'Network', 'Commands']

export class AgentToolsModal extends ReactModal<AgentToolsModalProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app,
      Component: AgentToolsModalWrapper,
      props: { plugin },
      options: {
        title: 'Agent tools',
      },
      plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
  }
}

function AgentToolsModalWrapper({
  plugin,
  onClose: _onClose,
}: AgentToolsModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <AgentToolsModalContent plugin={plugin} />
    </SettingsProvider>
  )
}

function AgentToolsModalContent({ plugin }: { plugin: SmartComposerPlugin }) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const [mcpManager, setMcpManager] = useState<McpManager | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerState[]>([])

  useEffect(() => {
    let isMounted = true
    void plugin
      .getMcpManager()
      .then((manager) => {
        if (!isMounted) {
          return
        }
        setMcpManager(manager)
        setMcpServers(manager.getServers())
      })
      .catch((error: unknown) => {
        console.error(
          'Failed to initialize MCP manager in AgentToolsModal',
          error,
        )
      })

    return () => {
      isMounted = false
    }
  }, [plugin])

  useEffect(() => {
    if (!mcpManager) {
      return
    }
    const unsubscribe = mcpManager.subscribeServersChange((servers) => {
      setMcpServers(servers)
    })
    return () => {
      unsubscribe()
    }
  }, [mcpManager])

  const mcpTools = useMemo(
    () =>
      mcpServers
        .filter((server) => server.status === McpServerStatus.Connected)
        .flatMap((server) =>
          server.tools.map((tool) => {
            const option = server.config.toolOptions[tool.name]
            return {
              id: `${server.name}:${tool.name}`,
              name: tool.name,
              source: server.name,
              serverId: server.name,
              enabled: !(option?.disabled ?? false),
            }
          }),
        ),
    [mcpServers],
  )

  const toolsCountLabel = t(
    'settings.agent.toolsCount',
    '{count} tools',
  ).replace('{count}', String(BUILTIN_TOOLS.length + mcpTools.length))

  const enabledToolsLabel = t(
    'settings.agent.toolsEnabledCount',
    '{count} enabled',
  ).replace(
    '{count}',
    String(
      BUILTIN_TOOLS.length + mcpTools.filter((tool) => tool.enabled).length,
    ),
  )

  const handleToggleMcpTool = (
    serverId: string,
    toolName: string,
    enabled: boolean,
  ) => {
    void Promise.resolve(
      setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          servers: settings.mcp.servers.map((server) => {
            if (server.id !== serverId) {
              return server
            }
            return {
              ...server,
              toolOptions: {
                ...server.toolOptions,
                [toolName]: {
                  ...server.toolOptions[toolName],
                  disabled: !enabled,
                },
              },
            }
          }),
        },
      }),
    ).catch((error: unknown) => {
      console.error('Failed to toggle MCP tool in AgentToolsModal', error)
    })
  }

  return (
    <div className="smtcmp-settings-section smtcmp-settings-section--tight">
      <div className="smtcmp-settings-desc">
        {toolsCountLabel} · {enabledToolsLabel}
      </div>
      <div className="smtcmp-agent-tools-modal-content">
        <div className="smtcmp-agent-tool-list">
          {BUILTIN_TOOLS.map((name) => (
            <div key={name} className="smtcmp-agent-tool-row">
              <div className="smtcmp-agent-tool-main">
                <div className="smtcmp-agent-tool-name">{name}</div>
                <div className="smtcmp-agent-tool-source">
                  {t('settings.agent.toolSourceBuiltin', 'Built-in')}
                </div>
              </div>
              <span className="smtcmp-agent-chip smtcmp-agent-chip--status">
                {t('settings.mcp.enabled', 'Enabled')}
              </span>
            </div>
          ))}

          {mcpTools.map((tool) => (
            <div key={tool.id} className="smtcmp-agent-tool-row">
              <div className="smtcmp-agent-tool-main">
                <div className="smtcmp-agent-tool-name smtcmp-agent-tool-name--mono">
                  {tool.name}
                </div>
                <div className="smtcmp-agent-tool-source">
                  {t('settings.agent.toolSourceMcp', 'MCP')}: {tool.source}
                </div>
              </div>
              <div className="smtcmp-agent-tool-toggle">
                <ObsidianToggle
                  value={tool.enabled}
                  onChange={(enabled) =>
                    handleToggleMcpTool(tool.serverId, tool.name, enabled)
                  }
                />
              </div>
            </div>
          ))}

          {mcpTools.length === 0 && (
            <div className="smtcmp-agent-tools-empty">
              {t('settings.agent.noMcpTools', 'No MCP tools discovered yet')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
