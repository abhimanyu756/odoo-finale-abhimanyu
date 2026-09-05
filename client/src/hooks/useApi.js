import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';

// Small data-fetching hook: every list and detail screen shares the same
// loading / error / refetch shape so pages stay declarative.
export function useFetch(url, { params, skip } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!skip);
  const [error, setError] = useState(null);

  const key = JSON.stringify(params ?? {});

  const run = useCallback(async () => {
    if (skip || !url) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(url, { params: params ?? undefined });
      setData(res.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
    // params is compared by value via `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, skip]);

  useEffect(() => {
    run();
  }, [run]);

  return { data, loading, error, refetch: run, setData };
}

export function useList(url, initialParams = {}) {
  const [params, setParams] = useState({ page: 1, limit: 25, ...initialParams });
  const { data, loading, error, refetch } = useFetch(url, { params });

  const setParam = useCallback((patch) => {
    // Any filter change resets to page 1; page changes are passed through.
    setParams((p) => ({ ...p, ...patch, ...(('page' in patch) ? {} : { page: 1 }) }));
  }, []);

  return {
    rows: data?.rows ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? params.page,
    pages: data?.pages ?? 1,
    params,
    setParam,
    loading,
    error,
    refetch,
  };
}
