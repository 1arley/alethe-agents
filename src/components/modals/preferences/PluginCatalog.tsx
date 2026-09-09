import { CloudOff, Download, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { PLUGIN_API_VERSION, usePlugins } from '../../../lib/plugins'
import { type CatalogPlugin, pluginCatalog, pluginCatalogOpen } from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import { CapabilityList } from './pluginCapabilities'
import styles from './PluginsPage.module.css'
import { SettingsSection } from './primitives'

export function PluginCatalog() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const installed = usePlugins()
  const [entries, setEntries] = useState<CatalogPlugin[] | null>(null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true)
      try {
        const snapshot = await pluginCatalog(PLUGIN_API_VERSION, refresh)
        setEntries(snapshot.plugins)
        setStale(snapshot.stale)
        setError(null)
      } catch (cause) {
        setEntries([])
        setError(String(cause))
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const open = async (plugin: CatalogPlugin) => {
    try {
      await pluginCatalogOpen(PLUGIN_API_VERSION, plugin.downloadUrl)
    } catch (cause) {
      pushToast({ title: t('prefs.pluginsCatalogOpenError'), body: String(cause) })
    }
  }

  return (
    <SettingsSection
      id="plugins-catalog"
      title={t('prefs.pluginsCatalogTitle')}
      description={t('prefs.pluginsCatalogDesc')}
    >
      <div className={styles.catalogHead}>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSm}`}
          disabled={loading}
          onClick={() => void load(true)}
        >
          <RefreshCw size={13} />
          {t('prefs.pluginsCatalogRefresh')}
        </button>
        {stale ? (
          <span className={styles.catalogStale}>
            <CloudOff size={13} />
            {t('prefs.pluginsCatalogStale')}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className={styles.emptyNote}>{t('prefs.pluginsCatalogError')}</div>
      ) : entries === null ? (
        <div className={styles.emptyNote}>{t('prefs.pluginsCatalogLoading')}</div>
      ) : entries.length === 0 ? (
        <div className={styles.emptyNote}>{t('prefs.pluginsCatalogEmpty')}</div>
      ) : (
        <div className={styles.list}>
          {entries.map((plugin) => {
            const alreadyInstalled = installed.some((entry) => entry.manifest.id === plugin.id)
            return (
              <div key={plugin.id} className={styles.row}>
                <div className={styles.rowHead}>
                  <div className={styles.identity}>
                    <div className={styles.titleLine}>
                      <span className={styles.name}>{plugin.name}</span>
                      {plugin.version ? (
                        <span className={styles.version}>
                          {t('prefs.pluginsVersion', { version: plugin.version })}
                        </span>
                      ) : null}
                      {alreadyInstalled ? (
                        <span className={styles.badge}>{t('prefs.pluginsCatalogInstalled')}</span>
                      ) : null}
                    </div>
                    {plugin.description ? (
                      <p className={styles.description}>{plugin.description}</p>
                    ) : null}
                    {plugin.author ? (
                      <p className={styles.description}>
                        {t('prefs.pluginsCatalogBy', { author: plugin.author })}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnSm}`}
                    onClick={() => void open(plugin)}
                  >
                    <Download size={13} />
                    {t('prefs.pluginsCatalogGet')}
                  </button>
                </div>
                <CapabilityList capabilities={plugin.capabilities} />
              </div>
            )
          })}
        </div>
      )}

      <p className={styles.importHint}>{t('prefs.pluginsCatalogHint')}</p>
    </SettingsSection>
  )
}
