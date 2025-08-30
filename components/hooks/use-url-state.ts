import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * Updates the URL with new search parameters
 * @internal
 */
function updateUrl(params: URLSearchParams): void {
  const queryString = params.toString();
  const newUrl = queryString ? `?${queryString}` : window.location.pathname;
  window.history.replaceState({}, '', newUrl);
}

/**
 * Hook for managing a string URL query parameter
 * Similar to useState but syncs with URL query params
 *
 * @param key - The query parameter key
 * @param defaultValue - Default value if parameter is not present
 * @returns [value, setValue] tuple similar to useState
 *
 * @example
 * const [search, setSearch] = useUrlState('q', '');
 * // URL: ?q=hello -> search = 'hello'
 * // setSearch('world') -> URL becomes ?q=world
 *
 * @example
 * const [page, setPage] = useUrlState('page', 1);
 * // URL: ?page=5 -> page = 5
 * // setPage(10) -> URL becomes ?page=10
 *
 * @example
 * const [enabled, setEnabled] = useUrlState('enabled', false);
 * // URL: ?enabled=true -> enabled = true
 * // setEnabled(true) -> URL becomes ?enabled=true
 */
export function useUrlState<T extends string | number | boolean>(
  key: string,
  defaultValue: T
): [T, (value: T) => void] {
  const searchParams = useSearchParams();

  const value = useMemo(() => {
    const rawValue = searchParams.get(key);

    if (rawValue === null) {
      return defaultValue;
    }

    // Parse based on default value type
    if (typeof defaultValue === 'boolean') {
      return rawValue === 'true';
    }

    if (typeof defaultValue === 'number') {
      const parsed = Number(rawValue);
      return isNaN(parsed) ? defaultValue : parsed;
    }

    return rawValue;
  }, [searchParams, key, defaultValue]);

  const setValue = useCallback((newValue: string | number | boolean) => {
    const params = new URLSearchParams(searchParams);

    if (newValue === defaultValue || (typeof defaultValue === 'string' && !newValue)) {
      params.delete(key);
    } else {
      params.set(key, String(newValue));
    }

    updateUrl(params);
  }, [searchParams, key, defaultValue]);

  return [value, setValue] as unknown as [T, (value: T) => void];
}

/**
 * Hook for managing an array URL query parameter
 * Uses repeated parameters format (?tags=a&tags=b&tags=c)
 *
 * @param key - The query parameter key
 * @param defaultValue - Default value if parameter is not present
 * @returns [value, setValue] tuple similar to useState
 *
 * @example
 * const [tags, setTags] = useUrlArrayState('tags', []);
 * // URL: ?tags=foo&tags=bar&tags=baz -> tags = ['foo', 'bar', 'baz']
 * // setTags(['a', 'b']) -> URL becomes ?tags=a&tags=b
 */
export function useUrlArrayState(
  key: string,
  defaultValue: string[] = []
): [string[], (value: string[]) => void] {
  const searchParams = useSearchParams();

  const value = useMemo(() => {
    const allValues = searchParams.getAll(key);
    return allValues.length > 0 ? allValues : defaultValue;
  }, [searchParams, key, defaultValue]);

  const setValue = useCallback((newValue: string[]) => {
    const params = new URLSearchParams(searchParams);

    // Remove all existing values for this key
    params.delete(key);

    // Add each value as a separate parameter
    if (newValue.length > 0) {
      newValue.forEach(v => params.append(key, v));
    }

    updateUrl(params);
  }, [searchParams, key]);

  return [value, setValue];
}

/**
 * Hook for managing an object/record as flattened URL query parameters
 * Each key-value pair becomes a separate query parameter with a prefix
 *
 * @param prefix - Prefix for the parameter keys
 * @param defaultValue - Default value if parameters are not present
 * @returns [value, setValue] tuple similar to useState
 *
 * @example
 * const [filters, setFilters] = useUrlRecordState('filter', {});
 * // URL: ?filter.age=25&filter.name=John -> filters = { age: '25', name: 'John' }
 * // setFilters({ age: '30' }) -> URL becomes ?filter.age=30
 */
export function useUrlRecordState<T extends Record<string, string>>(
  prefix: string,
  defaultValue: T = {} as T
): [T, (value: T) => void] {
  const searchParams = useSearchParams();

  const value = useMemo(() => {
    const result: Record<string, string> = {};
    let hasValues = false;

    searchParams.forEach((value, key) => {
      if (key.startsWith(`${prefix}.`)) {
        const fieldKey = key.substring(prefix.length + 1);
        result[fieldKey] = value;
        hasValues = true;
      }
    });

    return hasValues ? (result as T) : defaultValue;
  }, [searchParams, prefix, defaultValue]);

  const setValue = useCallback((newValue: T) => {
    const params = new URLSearchParams(searchParams);

    // Remove all existing parameters with this prefix
    Array.from(params.keys()).forEach(key => {
      if (key.startsWith(`${prefix}.`)) {
        params.delete(key);
      }
    });

    // Add new parameters
    Object.entries(newValue).forEach(([key, val]) => {
      if (val) {
        params.set(`${prefix}.${key}`, String(val));
      }
    });

    updateUrl(params);
  }, [searchParams, prefix]);

  return [value, setValue];
}
