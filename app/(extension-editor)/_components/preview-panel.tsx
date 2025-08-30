'use client';

import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  type Node,
} from '@xyflow/react';
import { useMemo } from 'react';

import '@/app/(dashboard)/_canvas/flow-editor.css';
import { buildNodeTypes } from '@/app/(dashboard)/_canvas/node-wrapper';
import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry';

interface PreviewPanelProps {
  previewTypeId: string | null;
  version: number;
}

export function PreviewPanel({ previewTypeId, version }: PreviewPanelProps) {
  const resolved = useMemo(
    () => (previewTypeId ? extensionRegistry.resolveNode(previewTypeId) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewTypeId, version],
  );

  const nodeTypes = useMemo(
    () => (resolved ? buildNodeTypes([resolved]) : {}),
    [resolved],
  );

  const nodes: Node[] = useMemo(() => {
    if (!resolved) {
      return [];
    }
    return [
      {
        id: 'preview',
        type: resolved.typeId,
        position: { x: 0, y: 0 },
        data: { ...resolved.defaultData },
        selected: true,
        draggable: false,
      },
    ];
  }, [resolved]);

  if (!resolved) {
    return (
      <div className='h-full w-full flex items-center justify-center text-xs text-muted-foreground'>
        Compile to preview
      </div>
    );
  }

  return (
    <div className='h-full w-full dashboard-mvp-flow'>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          selectionOnDrag={false}
          fitView
          fitViewOptions={{ padding: 0.6, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={10} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
