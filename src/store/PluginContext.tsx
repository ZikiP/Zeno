import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getActivePlugin } from '@/store/db';
import type { Plugin } from '@/site/types';

interface PluginCtxValue {
  plugin: Plugin | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const PluginCtx = createContext<PluginCtxValue>({
  plugin: null,
  loading: true,
  reload: async () => {},
});

export function PluginProvider({ children }: { children: ReactNode }) {
  const [plugin, setPlugin] = useState<Plugin | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    setPlugin(await getActivePlugin());
    setLoading(false);
  };

  useEffect(() => {
    reload();
  }, []);

  return <PluginCtx.Provider value={{ plugin, loading, reload }}>{children}</PluginCtx.Provider>;
}

export const usePlugin = () => useContext(PluginCtx);
