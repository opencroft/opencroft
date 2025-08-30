'use client';

import { BookOpen, ChevronDown, FilePlus, Loader2, Menu, Pencil, Trash2, X, FileText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { DocCommentsOverlay } from '@/app/(docs)/docs/_components/doc-comments';
import { DocEditor } from '@/app/(docs)/docs/_components/doc-editor';
import { createDoc, deleteDoc, enterEditMode } from '@/app/(docs)/docs/actions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/layout/scroll-area';
import { ScrollHeader } from '@/components/ui/layout/scrollpage';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

interface DocEntry { name: string; path: string; type: 'file' | 'directory'; children?: DocEntry[] }
interface TocItem { id: string; text: string; level: number }

// ─── Constants ──────────────────────────────────────────────────────────────

const API = '/docs/api/list';
const SCROLL_DURATION = 250;
const SCROLL_OFFSET = 80;

// ─── Slug helpers ───────────────────────────────────────────────────────────

function slugify(c: React.ReactNode): string {
  return extractText(c).toLowerCase().replace(/[^\w\s-а-яёА-ЯЁ]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

function extractText(n: React.ReactNode): string {
  if (typeof n === 'string') {
    return n;
  }
  if (typeof n === 'number') {
    return String(n);
  }
  if (!n) {
    return '';
  }
  if (Array.isArray(n)) {
    return n.map(extractText).join('');
  }
  if (typeof n === 'object' && 'props' in n) {
    return extractText((n as React.ReactElement).props.children);
  }
  return '';
}

// ─── TOC extraction ─────────────────────────────────────────────────────────

function extractToc(html: string): TocItem[] {
  const items: TocItem[] = [];
  const re = /<h([2-3])[^>]*id="([^"]*)"[^>]*>(.*?)<\/h\1>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    items.push({ id: m[2], text: m[3].replace(/<[^>]+>/g, ''), level: +m[1] });
  }
  return items;
}

// ─── File tree helpers ──────────────────────────────────────────────────────

function findFirstFile(entries: DocEntry[]): string | null {
  for (const e of entries) {
    if (e.type === 'file') {
      return e.path;
    }
    if (e.children) {
      const f = findFirstFile(e.children);
      if (f) {
        return f;
      }
    }
  }
  return null;
}

// ─── Scroll area helper ─────────────────────────────────────────────────────

function getScrollViewport(): HTMLElement | null {
  return document.querySelector('.prose-docs')?.closest('[data-slot="scroll-area-viewport"]') ?? null;
}

// ─── Active indicator (shared logic for left sidebar & right TOC) ───────────

function moveIndicator(
  container: Element | null,
  indicator: Element | null,
  activeEl: Element | null,
) {
  if (!indicator || !container) {
    return;
  }

  if (activeEl) {
    indicator.style.opacity = '1';
    const containerRect = container.getBoundingClientRect();
    const elRect = activeEl.getBoundingClientRect();
    indicator.style.top = `${elRect.top - containerRect.top + container.scrollTop}px`;
    indicator.style.height = `${elRect.height}px`;
  } else {
    indicator.style.opacity = '0';
  }
}

// ─── Sidebar Nav ────────────────────────────────────────────────────────────

function SidebarNav({ entries, selectedPath, onSelect, expandedPaths, onToggle, onDelete, depth = 0 }: {
  entries: DocEntry[]; selectedPath: string | null; onSelect: (p: string) => void;
  expandedPaths: Set<string>; onToggle: (p: string) => void;
  onDelete: (path: string) => void; depth?: number;
}) {
  return (
    <ul data-sidebar-nav className="m-0 list-none relative pr-3 py-1">
      {/* Right-side sliding indicator for selected file */}
      <span
        data-sidebar-indicator
        className="absolute right-0 w-0.5 bg-primary rounded-full will-change-transform"
        style={{
          top: 0,
          height: 0,
          opacity: 0,
          transition: 'top 350ms cubic-bezier(0.22, 1, 0.36, 1), height 350ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms',
        }}
      />
      {entries.map(entry => {
        if (entry.type === 'directory') {
          const isExpanded = expandedPaths.has(entry.path);
          const hasChildren = entry.children && entry.children.length > 0;
          return (
            <li key={entry.path}>
              <button
                onClick={() => hasChildren && onToggle(entry.path)}
                className="flex items-center gap-1 w-full text-left text-sm py-1.5 px-2 rounded-sm hover:bg-accent/50 transition-colors"
                style={{ paddingLeft: `${depth * 12 + 4}px` }}
              >
                {hasChildren && (
                  <ChevronDown className={cn(
                    'size-3.5 shrink-0 text-muted-foreground transition-transform',
                    !isExpanded && '-rotate-90',
                  )} />
                )}
                {!hasChildren && <span className="w-3.5 shrink-0" />}
                <span className="truncate font-medium">{entry.name}</span>
              </button>
              {isExpanded && hasChildren && (
                <SidebarNav
                  entries={entry.children!}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  expandedPaths={expandedPaths}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  depth={depth + 1}
                />
              )}
            </li>
          );
        }

        const isSelected = selectedPath === entry.path;
        return (
          <li key={entry.path} className="group/file relative">
            <a
              href={`/docs?file=${encodeURIComponent(entry.path)}`}
              onClick={e => {
                e.preventDefault(); onSelect(entry.path);
              }}
              data-sidebar-file={entry.path}
              className={cn(
                'flex items-center gap-1 w-full text-left text-sm py-1.5 px-2 pr-8 rounded-sm transition-colors',
                'hover:bg-accent/50 text-muted-foreground hover:text-foreground',
                isSelected && 'text-foreground',
              )}
              style={{ paddingLeft: `${depth * 12 + 4}px` }}
            >
              <FileText className="size-3.5 shrink-0 opacity-50" />
              <span className="truncate">{entry.name.replace(/\.md$/, '')}</span>
            </a>
            <button
              onClick={e => {
                e.preventDefault(); e.stopPropagation(); onDelete(entry.path);
              }}
              title="Delete"
              aria-label="Delete"
              className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center size-5 rounded-sm text-muted-foreground opacity-0 group-hover/file:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ─── TOC List (hierarchical with left border indicator) ─────────────────────

function TocList({ items, onActiveChange }: { items: TocItem[]; onActiveChange: (id: string) => void }) {
  const groups: { h2: TocItem; children: TocItem[] }[] = [];
  let current: { h2: TocItem; children: TocItem[] } | null = null;

  for (const item of items) {
    if (item.level === 2) {
      current = { h2: item, children: [] };
      groups.push(current);
    } else if (current) {
      current.children.push(item);
    }
  }

  return (
    <ul data-toc-list className="m-0 list-none pl-4 py-2 relative">
      {/* Sliding indicator — controlled by parent via DOM */}
      <span
        data-toc-indicator
        className="absolute left-0 w-0.5 bg-primary rounded-full will-change-transform"
        style={{
          top: 0,
          height: 0,
          opacity: 0,
          transition: 'top 350ms cubic-bezier(0.22, 1, 0.36, 1), height 350ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms',
        }}
      />
      {groups.map(({ h2, children }) => (
        <li key={h2.id} className="mb-1">
          <a
            href={`#${h2.id}`}
            onClick={e => {
              e.preventDefault();
              onActiveChange(h2.id);
            }}
            data-toc-id={h2.id}
            data-toc-level={2}
            className="block text-xs leading-relaxed py-0.5 -ml-4 pl-4 text-muted-foreground hover:text-foreground transition-colors"
          >
            {h2.text}
          </a>
          {children.length > 0 && (
            <ul className="m-0 list-none">
              {children.map(h3 => (
                <li key={h3.id}>
                  <a
                    href={`#${h3.id}`}
                    onClick={e => {
                      e.preventDefault();
                      onActiveChange(h3.id);
                    }}
                    data-toc-id={h3.id}
                    data-toc-level={3}
                    className="block text-xs leading-relaxed py-0.5 -ml-4 pl-8 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {h3.text}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── Markdown Content ───────────────────────────────────────────────────────

function MarkdownContent({ content, onRendered }: { content: string; onRendered: (html: string) => void }) {
  const ref = useCallback(
    (n: HTMLDivElement | null) => {
      if (n) {
        onRendered(n.innerHTML);
      }
    },
    [content],
  );
  return (
    <div className="prose-docs" ref={ref}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children, ...p }) => <h2 id={slugify(children)} {...p}>{children}</h2>,
          h3: ({ children, ...p }) => <h3 id={slugify(children)} {...p}>{children}</h3>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function DocsPage() {
  const [tree, setTree] = useState<DocEntry[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [docContent, setDocContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initError, setInitError] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [renderedHtml, setRenderedHtml] = useState('');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPath, setCreatePath] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Refs for DOM-only highlight updates
  const lastTocActiveRef = useRef<string | null>(null);
  const lastSidebarActiveRef = useRef<string | null>(null);
  const headingsRef = useRef<Element[]>([]);
  const scrollingFromClickRef = useRef(false);

  // ── Fetch file tree ───────────────────────────────────────────────────────
  const refreshTree = useCallback(async () => {
    const r = await fetch(API);
    if (!r.ok) {
      throw new Error();
    }
    const next = await r.json() as DocEntry[];
    setTree(next);
    return next;
  }, []);

  useEffect(() => {
    refreshTree().catch(() => setInitError(true));
  }, [refreshTree]);

  // ── Auto-expand parent directories when selecting a file ──────────────────
  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    const parts = selectedPath.split('/');
    const next = new Set(expandedPaths);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      next.add(cur);
    }
    setExpandedPaths(next);
  }, [selectedPath]);

  // ── Auto-select first file when tree loads ────────────────────────────────
  useEffect(() => {
    if (tree && tree.length > 0 && !selectedPath) {
      const f = findFirstFile(tree);
      if (f) {
        setSelectedPath(f);
      }
    }
  }, [tree, selectedPath]);

  // ── Load document content ─────────────────────────────────────────────────
  const loadDoc = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setDocContent(null);
    setRenderedHtml('');
    lastTocActiveRef.current = null;
    try {
      const r = await fetch(`${API}?file=${encodeURIComponent(path)}`);
      if (!r.ok) {
        throw new Error();
      }
      setDocContent((await r.json() as { content: string }).content);
    } catch {
      setError('Failed to load document');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (selectedPath) {
      setEditing(false);
      setEditContent(null);
      loadDoc(selectedPath);
    }
  }, [selectedPath, loadDoc]);

  const handleStartEdit = useCallback(async () => {
    if (!selectedPath) {
      return;
    }
    const draft = await enterEditMode(selectedPath);
    setEditContent(draft);
    setEditing(true);
  }, [selectedPath]);

  const handlePublish = useCallback((published: string) => {
    setDocContent(published);
    setRenderedHtml('');
    setEditing(false);
    setEditContent(null);
  }, []);

  const handleDiscard = useCallback(() => {
    setEditing(false);
    setEditContent(null);
  }, []);

  const handleCreate = useCallback(async () => {
    setCreateError(null);
    try {
      const created = await createDoc(createPath);
      await refreshTree();
      setCreateOpen(false);
      setCreatePath('');
      setSelectedPath(created);
      const draft = await enterEditMode(created);
      setEditContent(draft);
      setEditing(true);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create');
    }
  }, [createPath, refreshTree]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }
    await deleteDoc(deleteTarget);
    const next = await refreshTree();
    if (selectedPath === deleteTarget) {
      setSelectedPath(findFirstFile(next));
      setEditing(false);
      setEditContent(null);
      setDocContent(null);
    }
    setDeleteTarget(null);
  }, [deleteTarget, selectedPath, refreshTree]);

  // ── DOM-only TOC highlight (no React re-render) ───────────────────────────
  const updateTocHighlight = useCallback((newActive: string | null) => {
    if (newActive === lastTocActiveRef.current) {
      return;
    }
    const prev = lastTocActiveRef.current;
    lastTocActiveRef.current = newActive;

    const tocList = document.querySelector('[data-toc-list]');
    if (!tocList) {
      return;
    }

    // Remove highlight from previous
    if (prev) {
      const prevEl = tocList.querySelector(`[data-toc-id="${prev}"]`);
      if (prevEl) {
        prevEl.classList.remove('text-foreground');
        prevEl.classList.add('text-muted-foreground');
      }
    }

    // Add highlight + move indicator
    const indicator = tocList.querySelector('[data-toc-indicator]');
    const el = newActive ? tocList.querySelector(`[data-toc-id="${newActive}"]`) : null;

    if (el && indicator) {
      el.classList.remove('text-muted-foreground');
      el.classList.add('text-foreground');
      moveIndicator(tocList, indicator, el);
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (indicator) {
      moveIndicator(tocList, indicator, null);
    }
  }, []);

  // ── DOM-only sidebar indicator ────────────────────────────────────────────
  const updateSidebarIndicator = useCallback((filePath: string | null) => {
    if (filePath === lastSidebarActiveRef.current) {
      return;
    }
    const prev = lastSidebarActiveRef.current;
    lastSidebarActiveRef.current = filePath;

    const nav = document.querySelector('[data-sidebar-nav]');
    if (!nav) {
      return;
    }

    if (prev) {
      const prevEl = nav.querySelector(`[data-sidebar-file="${prev}"]`);
      if (prevEl) {
        prevEl.classList.remove('text-foreground');
        prevEl.classList.add('text-muted-foreground');
      }
    }

    const indicator = nav.querySelector('[data-sidebar-indicator]');
    const el = filePath ? nav.querySelector(`[data-sidebar-file="${filePath}"]`) : null;

    if (el && indicator) {
      el.classList.remove('text-muted-foreground');
      el.classList.add('text-foreground');
      moveIndicator(nav, indicator, el);
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (indicator) {
      moveIndicator(nav, indicator, null);
    }
  }, []);

  // ── Cache heading elements when content renders ───────────────────────────
  useEffect(() => {
    if (!renderedHtml) {
      headingsRef.current = [];
      lastTocActiveRef.current = null;
      return;
    }
    headingsRef.current = Array.from(document.querySelectorAll('.prose-docs h2, .prose-docs h3'));
    // Set initial active to first heading
    if (headingsRef.current.length > 0) {
      updateTocHighlight(headingsRef.current[0].id);
    }
  }, [renderedHtml, updateTocHighlight]);

  // ── Update sidebar indicator on file selection ────────────────────────────
  useEffect(() => {
    updateSidebarIndicator(selectedPath);
  }, [selectedPath, updateSidebarIndicator]);

  // ── Scroll-based TOC tracking ─────────────────────────────────────────────
  useEffect(() => {
    if (!renderedHtml) {
      return;
    }
    const viewport = getScrollViewport();
    if (!viewport) {
      return;
    }

    const update = () => {
      if (scrollingFromClickRef.current) {
        return;
      }
      const scrollTop = viewport.scrollTop;
      const headings = headingsRef.current;

      if (headings.length === 0) {
        return;
      }

      // Find the last heading that scrolled past the offset
      let active: string | null = null;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].getBoundingClientRect().top - SCROLL_OFFSET <= 0) {
          active = headings[i].id;
        } else {
          break;
        }
      }

      // Fallback: if scroll is at top and no heading matched, use first heading
      if (active === null && scrollTop < 10 && headings.length > 0) {
        active = headings[0].id;
      }

      if (active !== lastTocActiveRef.current) {
        updateTocHighlight(active);
      }
    };

    const onScroll = () => requestAnimationFrame(update);
    viewport.addEventListener('scroll', onScroll, { passive: true });
    update(); // Initial check
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [renderedHtml, updateTocHighlight]);

  // ── TOC click → smooth scroll with animation ──────────────────────────────
  const handleTocClick = useCallback((id: string) => {
    scrollingFromClickRef.current = true;
    updateTocHighlight(id);

    const viewport = getScrollViewport();
    const el = document.getElementById(id);
    if (!viewport || !el) {
      scrollingFromClickRef.current = false;
      return;
    }

    const target = el.offsetTop - SCROLL_OFFSET;
    const start = viewport.scrollTop;
    const distance = target - start;
    if (distance === 0) {
      scrollingFromClickRef.current = false;
      return;
    }

    let startTime: number | null = null;
    const animate = (timestamp: number) => {
      if (!startTime) {
        startTime = timestamp;
      }
      const elapsed = timestamp - startTime;
      const progress = Math.min(elapsed / SCROLL_DURATION, 1);
      const eased = 1 - Math.pow(1 - progress, 5); // ease-out quint
      viewport.scrollTop = start + distance * eased;
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        scrollingFromClickRef.current = false;
      }
    };
    requestAnimationFrame(animate);
  }, [updateTocHighlight]);

  const tocItems = useMemo(() => extractToc(renderedHtml), [renderedHtml]);

  const handleToggle = useCallback((dirPath: string) => {
    setExpandedPaths(prev => {
      const n = new Set(prev);
      if (n.has(dirPath)) {
        n.delete(dirPath);
      } else {
        n.add(dirPath);
      }
      return n;
    });
  }, []);

  // ── Error & loading states ────────────────────────────────────────────────

  if (initError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <BookOpen className="size-12" />
        <p className="text-lg font-medium">Docs not available</p>
        <p className="text-sm">Mount the docs directory to /app/docs in the container.</p>
      </div>
    );
  }

  if (tree === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <BookOpen className="size-12" />
        <p className="text-lg font-medium">No documents found</p>
        <p className="text-sm">Mount the docs directory to /app/docs in the container.</p>
      </div>
    );
  }

  // ── Content renderer ──────────────────────────────────────────────────────
  const contentEl = (
    <>
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-destructive">
          <p className="font-medium">Error</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      )}
      {editing && editContent !== null && selectedPath && (
        <DocEditor
          filePath={selectedPath}
          initialContent={editContent}
          onPublish={handlePublish}
          onDiscard={handleDiscard}
        />
      )}
      {selectedPath && docContent !== null && !loading && !editing && !error && (
        <>
          <div className="flex justify-end mb-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleStartEdit}
            >
              <Pencil /> Edit
            </Button>
          </div>
          <div className="relative">
            <MarkdownContent content={docContent} onRendered={setRenderedHtml} />
            <DocCommentsOverlay docPath={selectedPath} renderKey={renderedHtml} />
          </div>
        </>
      )}
      {!selectedPath && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
          <FileText className="size-10" />
          <p className="text-sm">Select a file from the sidebar</p>
        </div>
      )}
    </>
  );

  // ── Sidebar nav element (shared between desktop & mobile) ─────────────────
  const sidebarNav = (
    <SidebarNav
      entries={tree}
      selectedPath={selectedPath}
      onSelect={setSelectedPath}
      expandedPaths={expandedPaths}
      onToggle={handleToggle}
      onDelete={setDeleteTarget}
    />
  );

  const sidebarHeader = (
    <>
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Documentation</span>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={() => {
          setCreateError(null); setCreatePath(''); setCreateOpen(true);
        }}
        title="New document"
        aria-label="New document"
        className="ml-auto"
      >
        <FilePlus />
      </Button>
    </>
  );

  return (
    <div className="flex-1 min-h-0">
      {/* ── Desktop: centered 3-column layout ── */}
      <div className="hidden md:flex h-full min-h-0">
        <div className="mx-auto flex h-full min-h-0 max-w-7xl">

          {/* Left sidebar */}
          <aside className="shrink-0 overflow-hidden w-60">
            <ScrollArea className="h-full">
              <div className="flex flex-col h-full">
                <ScrollHeader className="px-4 py-2.5 shrink-0 sticky top-0 z-10 bg-background">
                  {sidebarHeader}
                </ScrollHeader>
                <div className="flex-1 min-h-0">
                  {sidebarNav}
                </div>
              </div>
            </ScrollArea>
          </aside>

          {/* Main content */}
          <div className="flex-1 min-h-0">
            <ScrollArea className="h-full">
              <div className="py-6 px-8 mx-auto w-4xl">
                {contentEl}
              </div>
            </ScrollArea>
          </div>

          {/* Right sidebar — TOC */}
          <aside className="shrink-0 overflow-hidden w-60">
            <ScrollArea className="h-full">
              <div className="flex flex-col h-full">
                {docContent && !loading && !editing ? (
                  <>
                    <ScrollHeader className="px-4 py-2.5 shrink-0 sticky top-0 z-10 bg-background">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">On this page</span>
                    </ScrollHeader>
                    <div className="flex-1 min-h-0">
                      {tocItems.length > 0 ? (
                        <TocList items={tocItems} onActiveChange={handleTocClick} />
                      ) : (
                        <p className="text-xs text-muted-foreground px-4 py-2">No headings</p>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            </ScrollArea>
          </aside>
        </div>
      </div>

      {/* ── Mobile ── */}
      <div className="md:hidden flex-1 min-h-0 flex flex-col">
        <ScrollHeader className="px-3 py-2">
          <button
            onClick={() => setSidebarOpen(true)}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent transition-colors"
          >
            <Menu className="size-4" />
          </button>
          <span className="text-sm text-muted-foreground truncate">
            {selectedPath?.replace(/\.md$/, '') ?? 'Docs'}
          </span>
        </ScrollHeader>
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-4 py-4 min-w-0">
            {contentEl}
          </div>
        </ScrollArea>
      </div>

      {/* ── Create doc dialog ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New document</DialogTitle>
            <DialogDescription>
              Enter a relative path. Nested folders will be created as needed. The .md extension is optional.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={createPath}
            onChange={e => {
              setCreatePath(e.target.value); setCreateError(null);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault(); handleCreate();
              }
            }}
            placeholder="guides/getting-started.md"
          />
          {createError && <p className="text-sm text-destructive">{createError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!createPath.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation ── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && (
                <>This will permanently delete <span className="font-mono">{deleteTarget}</span>.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDeleteConfirm}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Mobile drawer ── */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <div className="relative w-72 bg-background border-r shadow-lg h-full flex flex-col overflow-hidden">
            <ScrollHeader className="px-4 py-2">
              {sidebarHeader}
              <button
                onClick={() => setSidebarOpen(false)}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent transition-colors"
              >
                <X className="size-4" />
              </button>
            </ScrollHeader>
            <ScrollArea className="flex-1 min-h-0">
              <nav className="py-1">
                <SidebarNav
                  entries={tree}
                  selectedPath={selectedPath}
                  onSelect={p => {
                    setSelectedPath(p); setSidebarOpen(false);
                  }}
                  expandedPaths={expandedPaths}
                  onToggle={handleToggle}
                  onDelete={setDeleteTarget}
                />
              </nav>
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  );
}
