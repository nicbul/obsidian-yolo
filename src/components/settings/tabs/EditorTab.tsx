import { App } from 'obsidian'
import React from 'react'

import SmartComposerPlugin from '../../../main'
import { ChatPreferencesSection } from '../sections/ChatPreferencesSection'
import { ContinuationSection } from '../sections/ContinuationSection'

type EditorTabProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function EditorTab({ app }: EditorTabProps) {
  return (
    <>
      <ChatPreferencesSection />
      <ContinuationSection app={app} />
    </>
  )
}
