import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getActiveSite } from '@/store/db';
import type { SiteConfig } from '@/site/types';

interface SiteCtxValue {
  site: SiteConfig | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const SiteCtx = createContext<SiteCtxValue>({
  site: null,
  loading: true,
  reload: async () => {},
});

export function SiteProvider({ children }: { children: ReactNode }) {
  const [site, setSite] = useState<SiteConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    setSite(await getActiveSite());
    setLoading(false);
  };

  useEffect(() => {
    reload();
  }, []);

  return <SiteCtx.Provider value={{ site, loading, reload }}>{children}</SiteCtx.Provider>;
}

export const useSite = () => useContext(SiteCtx);
