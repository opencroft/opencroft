'use client';

import { type Node } from '@xyflow/react';
import * as lucideIcons from 'lucide-react';
import { Maximize2, Minimize2, Pencil, Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { useInspectorIntent } from '@/app/(dashboard)/_canvas/inspector-intent';
import { extensionRegistry, type ResolvedNode } from '@/app/(extension-runtime)/_client/registry';
import { type NodeData } from '@/app/(extension-runtime)/_types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/layout/scroll-area';
import { Separator } from '@/components/ui/separator';

function resolveIcon(name?: string): lucideIcons.LucideIcon {
  if (!name) {
    return lucideIcons.Box;
  }
  return (lucideIcons as unknown as Record<string, lucideIcons.LucideIcon>)[name] ?? lucideIcons.Box;
}

interface NodeInspectorProps {
  node: Node<NodeData> | null;
  expanded: boolean;
  extensions: ResolvedNode[];
  override?: ReactNode;
  updateNodeData: (nodeId: string, patch: Partial<NodeData>) => void;
  onDeselect: () => void;
  onEditExtension: (extensionId: string) => void;
  onNewExtension: () => void;
  onExpandedChange: (next: boolean) => void;
}

export function NodeInspector({
  node, expanded, extensions, override,
  updateNodeData, onDeselect, onEditExtension, onNewExtension, onExpandedChange,
}: NodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<string>('details');
  const intent = useInspectorIntent(node?.id ?? '');

  useEffect(() => {
    if (intent.tab) {
      setActiveTab(intent.tab);
    }
  }, [intent.tabRequestId, intent.tab]);

  if (override) {
    return <aside className='w-full h-full bg-card flex flex-col'>{override}</aside>;
  }

  if (!node) {
    return <NodeBrowser extensions={extensions} onEditExtension={onEditExtension} onNewExtension={onNewExtension} />;
  }

  const resolved = extensionRegistry.resolveNode(node.type!);
  if (!resolved) {
    return (
      <aside className='w-full h-full bg-card flex flex-col'>
        <div className='px-3 py-3 text-destructive text-xs'>
          Unknown extension: {node.type}
        </div>
      </aside>
    );
  }

  const Icon = resolved.icon;
  const Inspector = resolved.inspector;
  const inspectorTabs = resolved.inspectorTabs;
  const isLocal = resolved.extension.manifest.id.startsWith('local/');

  const hasTabs = inspectorTabs && inspectorTabs.length > 0;

  // Build all tabs: always include Details, then any extra tabs
  const tabs = hasTabs
    ? [
      { id: 'details', label: 'Details', icon: 'Settings' as const, fullHeight: false, component: Inspector },
      ...inspectorTabs.map((tab) => ({ ...tab, fullHeight: Boolean(tab.fullHeight) })),
    ]
    : [];

  const activeEntry = hasTabs ? tabs.find((t) => t.id === activeTab) : null;
  const ActiveComponent = activeEntry?.component ?? Inspector;
  const fillHeight = activeEntry?.fullHeight ?? false;

  const inspectorProps = {
    nodeId: node.id,
    data: node.data,
    updateData: (patch: Record<string, unknown>) => updateNodeData(node.id, patch),
  };

  const body = fillHeight ? (
    <div className='flex-1 min-h-0 flex flex-col w-full'>
      {ActiveComponent ? (
        <ActiveComponent {...inspectorProps} />
      ) : (
        <div className='text-xs text-muted-foreground italic p-2'>
          This extension has no editable properties.
        </div>
      )}
    </div>
  ) : (
    <ScrollArea className='flex-1 min-h-0'>
      <div className='py-2 px-4'>
        {ActiveComponent ? (
          <ActiveComponent {...inspectorProps} />
        ) : (
          <div className='text-xs text-muted-foreground italic'>
            This extension has no editable properties.
          </div>
        )}
      </div>
    </ScrollArea>
  );

  const ExpandIcon = expanded ? Minimize2 : Maximize2;

  return (
    <aside className='w-full h-full bg-card flex flex-col'>
      <div className='flex items-center gap-2 p-3'>
        <Icon className='size-4 shrink-0' style={{ color: resolved.accent }} />
        <span className='text-sm font-semibold flex-1 truncate'>{resolved.name}</span>
        {isLocal && (
          <Button
            variant='ghost'
            size='icon'
            className='size-6'
            title='Edit extension source'
            onClick={() => onEditExtension(resolved.extension.manifest.id)}
          >
            <Pencil className='size-3.5' />
          </Button>
        )}
        <Button
          variant='ghost'
          size='icon'
          className='size-6'
          onClick={() => onExpandedChange(!expanded)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <ExpandIcon className='size-3.5' />
        </Button>
        <Button variant='ghost' size='icon' className='size-6' onClick={onDeselect} title='Close'>
          <X className='size-3.5' />
        </Button>
      </div>
      <Separator />
      {hasTabs && (
        <>
          <div className='flex items-center gap-0 px-3 pt-2 pb-0'>
            {tabs.map((tab) => {
              const TabIcon = resolveIcon(tab.icon);
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type='button'
                  onClick={() => setActiveTab(tab.id)}
                  className={`
                    flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors
                    ${isActive
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground/80'
                }
                  `}
                >
                  <TabIcon className='size-3' />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <Separator />
        </>
      )}
      {body}
    </aside>
  );
}

interface NodeBrowserProps {
  extensions: ResolvedNode[];
  onEditExtension: (extensionId: string) => void;
  onNewExtension: () => void;
}

function NodeBrowser({ extensions, onEditExtension, onNewExtension }: NodeBrowserProps) {
  return (
    <aside className='w-full h-full bg-card flex flex-col'>
      <div className='flex items-center gap-2 p-3'>
        <span className='text-sm font-semibold flex-1 truncate'>Nodes</span>
        <Button variant='ghost' size='icon' className='size-6' onClick={onNewExtension} title='New extension'>
          <Plus className='size-3.5' />
        </Button>
      </div>
      <Separator />
      <ScrollArea className='flex-1 min-h-0'>
        <ul className='py-1'>
          {extensions.length === 0 ? (
            <li className='px-3 py-2 text-xs text-muted-foreground italic'>No nodes registered.</li>
          ) : (
            extensions.map((ext) => {
              const Icon = ext.icon;
              const isLocal = ext.extension.manifest.id.startsWith('local/');
              return (
                <li key={ext.typeId} className='group flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50'>
                  <Icon className='size-4 shrink-0' style={{ color: ext.accent }} />
                  <span className='text-sm truncate flex-1'>{ext.name}</span>
                  {isLocal && (
                    <Button
                      variant='ghost'
                      size='icon'
                      className='size-6 opacity-0 group-hover:opacity-100'
                      title='Edit extension source'
                      onClick={() => onEditExtension(ext.extension.manifest.id)}
                    >
                      <Pencil className='size-3.5' />
                    </Button>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </ScrollArea>
    </aside>
  );
}
