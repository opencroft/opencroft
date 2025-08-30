'use client';

import type { Edge, Node } from '@xyflow/react';
import { useCallback, useEffect } from 'react';

const FORMAT = 'opencroft/nodes';
const PASTE_OFFSET = 20;

interface Payload {
  format: typeof FORMAT;
  nodes: Node[];
  edges: Edge[];
}

interface Options {
  nodes: Node[];
  edges: Edge[];
  setNodes: (updater: (nodes: Node[]) => Node[]) => void;
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void;
  onChange: (nodes: Node[], edges: Edge[]) => void;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) {
    return false;
  }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return el.isContentEditable;
}

function selectedSet(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.selected && n.type !== 'comment');
}

function edgesBetween(edges: Edge[], ids: Set<string>): Edge[] {
  return edges.filter((e) => ids.has(e.source) && ids.has(e.target));
}

async function writePayload(nodes: Node[], edges: Edge[]): Promise<void> {
  const payload: Payload = { format: FORMAT, nodes, edges };
  await navigator.clipboard.writeText(JSON.stringify(payload));
}

async function readPayload(): Promise<Payload | null> {
  const text = await navigator.clipboard.readText();
  if (!text) {
    return null;
  }
  const data = JSON.parse(text) as Partial<Payload>;
  if (data.format !== FORMAT || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    return null;
  }
  return { format: FORMAT, nodes: data.nodes, edges: data.edges };
}

function remap(payload: Payload): { nodes: Node[]; edges: Edge[] } {
  const idMap = new Map<string, string>();
  const nodes = payload.nodes.map((n) => {
    const id = newId(n.type ?? 'node');
    idMap.set(n.id, id);
    return {
      ...n,
      id,
      position: { x: n.position.x + PASTE_OFFSET, y: n.position.y + PASTE_OFFSET },
      selected: true,
      ...(n.parentId ? { parentId: idMap.get(n.parentId) ?? n.parentId } : {}),
    };
  });
  const edges = payload.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      ...e,
      id: newId('edge'),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      selected: false,
    }));
  return { nodes, edges };
}

export function useClipboard({ nodes, edges, setNodes, setEdges, onChange }: Options) {
  const copy = useCallback(async () => {
    const picked = selectedSet(nodes);
    if (picked.length === 0) {
      return;
    }
    const ids = new Set(picked.map((n) => n.id));
    const pickedEdges = edgesBetween(edges, ids);
    await writePayload(picked, pickedEdges);
  }, [nodes, edges]);

  const cut = useCallback(async () => {
    const picked = selectedSet(nodes);
    if (picked.length === 0) {
      return;
    }
    const ids = new Set(picked.map((n) => n.id));
    const pickedEdges = edgesBetween(edges, ids);
    await writePayload(picked, pickedEdges);
    const nextNodes = nodes.filter((n) => !ids.has(n.id));
    const nextEdges = edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
    setNodes(() => nextNodes);
    setEdges(() => nextEdges);
    onChange(nextNodes, nextEdges);
  }, [nodes, edges, setNodes, setEdges, onChange]);

  const paste = useCallback(async () => {
    const payload = await readPayload();
    if (!payload) {
      return;
    }
    const { nodes: pastedNodes, edges: pastedEdges } = remap(payload);
    if (pastedNodes.length === 0) {
      return;
    }
    const nextNodes = [
      ...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
      ...pastedNodes,
    ];
    const nextEdges = [...edges, ...pastedEdges];
    setNodes(() => nextNodes);
    setEdges(() => nextEdges);
    onChange(nextNodes, nextEdges);
  }, [nodes, edges, setNodes, setEdges, onChange]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) {
        return;
      }
      if (isEditing()) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'c') {
        e.preventDefault();
        copy();
        return;
      }
      if (key === 'x') {
        e.preventDefault();
        cut();
        return;
      }
      if (key === 'v') {
        e.preventDefault();
        paste();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [copy, cut, paste]);
}
