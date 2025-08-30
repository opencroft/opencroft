'use client';

import { type Node, type NodeProps } from '@xyflow/react';
import { AlertTriangle } from 'lucide-react';
import { Component, memo, type ReactNode } from 'react';

import { NodeAccentProvider } from '@/app/(dashboard)/_canvas/node-frame';
import { extensionRegistry, type ResolvedNode } from '@/app/(extension-runtime)/_client/registry';
import { type NodeData } from '@/app/(extension-runtime)/_types';

interface NodeErrorBoundaryProps {
  typeId: string;
  children: ReactNode;
}

interface NodeErrorBoundaryState {
  error: Error | null;
}

class NodeErrorBoundary extends Component<NodeErrorBoundaryProps, NodeErrorBoundaryState> {
  state: NodeErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): NodeErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: NodeErrorBoundaryProps): void {
    if (prevProps.typeId !== this.props.typeId && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error): void {
    console.error(`[ext:${this.props.typeId}] render failed`, error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className='rounded-md border border-destructive bg-destructive/10 text-destructive px-2 py-1 text-xs max-w-60'>
          <div className='flex items-center gap-1 font-semibold'>
            <AlertTriangle className='size-3' />
            {this.props.typeId}
          </div>
          <div className='mt-1 font-mono text-[10px] truncate' title={this.state.error.message}>
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface NodeWrapperProps extends NodeProps<Node<NodeData>> {
  type: string;
}

function NodeWrapperImpl(props: NodeWrapperProps) {
  const resolved = extensionRegistry.resolveNode(props.type);
  if (!resolved) {
    return (
      <div className='rounded-md border border-destructive bg-destructive/10 text-destructive px-2 py-1 text-xs'>
        Unknown extension: {props.type}
      </div>
    );
  }
  const Component = resolved.component;
  return (
    <NodeAccentProvider accent={resolved.accent}>
      <NodeErrorBoundary typeId={props.type}>
        <Component {...props} />
      </NodeErrorBoundary>
    </NodeAccentProvider>
  );
}

export function buildNodeTypes(nodes: ResolvedNode[]) {
  const entries: Record<string, React.ComponentType<NodeProps<Node<NodeData>>>> = {};
  for (const resolved of nodes) {
    const typeId = resolved.typeId;
    const Wrapped = (props: NodeProps<Node<NodeData>>) => <NodeWrapperImpl {...props} type={typeId} />;
    Wrapped.displayName = `ExtensionNode(${typeId})`;
    entries[typeId] = memo(Wrapped);
  }
  return entries;
}
