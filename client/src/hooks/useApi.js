import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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

// Params that must come back from the URL as numbers - they are used in
// arithmetic (the pager's record range) rather than just passed through.
const NUMERIC_PARAMS = ['page', 'limit'];

const paramsToSearch = (params) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  return search;
};

/*
 * List state lives in the URL, not just in React state.
 *
 * Without this, opening a payslip and pressing Back re-mounts the list with its
 * filters reset - the user is returned to a different view than the one they
 * left. Keeping the params in the query string means Back restores exactly what
 * was on screen, and a filtered list can be linked or bookmarked.
 *
 * Filter changes replace the history entry rather than pushing one, so Back
 * steps out of the list instead of walking through every keystroke.
 */
export function useList(url, initialParams = {}) {
  const [search, setSearch] = useSearchParams();

  const params = useMemo(() => {
    const fromUrl = {};
    for (const [k, v] of search.entries()) {
      fromUrl[k] = NUMERIC_PARAMS.includes(k) ? Number(v) : v;
    }
    // The URL wins over the defaults, so a restored view is exact.
    return { page: 1, limit: 25, ...initialParams, ...fromUrl };
    // initialParams is a fresh object literal on every render at most call
    // sites, so it is compared by value rather than by identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, JSON.stringify(initialParams)]);

  const { data, loading, error, refetch } = useFetch(url, { params });

  const setParam = useCallback((patch) => {
    setSearch(
      (prev) => {
        const next = {};
        for (const [k, v] of prev.entries()) next[k] = v;
        Object.assign(next, patch);
        // Any filter change resets to page 1; page changes are passed through.
        if (!('page' in patch)) next.page = 1;
        return paramsToSearch(next);
      },
      { replace: true },
    );
  }, [setSearch]);

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
