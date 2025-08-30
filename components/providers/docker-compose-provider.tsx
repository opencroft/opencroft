'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { CreateDockerContainerData } from '@/app/(docker)/docker/server/actions';
import { DockerCompose } from '@/app/(docker)/docker/server/compose-actions';
import { docker } from '@/app/(docker)/docker/server/compose-wrapper';
import { DockerContext } from '@/app/(docker)/docker/server/context-actions';

interface DockerComposeState {
  composes: DockerCompose[];
  currentContext: string;
  contexts: DockerContext[];
  loading: boolean;
}

interface DockerComposeActions {
  loadComposes: () => Promise<void>;
  switchContext: (name: string) => Promise<void>;
  createCompose: (name: string) => Promise<void>;
  updateCompose: (name: string, content: string) => Promise<void>;
  deleteCompose: (name: string) => Promise<void>;
  renameCompose: (oldName: string, newName: string) => Promise<void>;
  addService: (composeName: string, serviceName: string, serviceData: CreateDockerContainerData) => Promise<void>;
  updateService: (composeName: string, oldServiceName: string, newServiceName: string, serviceData: CreateDockerContainerData) => Promise<void>;
  removeService: (composeName: string, serviceName: string) => Promise<void>;
  upCompose: (name: string) => Promise<void>;
  deployCompose: (name: string) => Promise<void>;
  stopCompose: (name: string) => Promise<void>;
  downCompose: (name: string) => Promise<void>;
  startService: (composeName: string, serviceName: string) => Promise<void>;
  stopService: (composeName: string, serviceName: string) => Promise<void>;
  terminateService: (composeName: string, serviceName: string) => Promise<void>;
  rebootService: (composeName: string, serviceName: string) => Promise<void>;
  deployService: (composeName: string, serviceName: string) => Promise<void>;
}

type DockerComposeContextType = DockerComposeState & { actions: DockerComposeActions };

const DockerComposeContext = createContext<DockerComposeContextType | null>(null);

export function DockerComposeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DockerComposeState>({
    composes: [],
    currentContext: 'default',
    contexts: [],
    loading: true,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadComposes = useCallback(async () => {
    setState(s => ({ ...s, loading: true }));
    const [ctx, ctxList] = await Promise.all([
      docker.getCurrentDockerContext(),
      docker.getDockerContexts(),
    ]);
    const data = await docker.getDockerComposes(ctx);
    setState({ composes: data, currentContext: ctx, contexts: ctxList, loading: false });
  }, []);

  const withContext = useCallback(() => stateRef.current.currentContext, []);

  const withReload = useCallback(async (fn: () => Promise<void>) => {
    await fn();
    const data = await docker.getDockerComposes(stateRef.current.currentContext);
    setState(s => ({ ...s, composes: data }));
  }, []);

  const switchContext = useCallback(async (name: string) => {
    setState(s => ({ ...s, loading: true, currentContext: name }));
    const data = await docker.getDockerComposes(name);
    setState(s => ({ ...s, composes: data, currentContext: name, loading: false }));
  }, []);

  const deleteCompose = useCallback(async (name: string) => {
    await docker.deleteDockerCompose(withContext(), name);
    setState(s => ({ ...s, composes: s.composes.filter(c => c.name !== name) }));
  }, [withContext]);

  const actions: DockerComposeActions = useMemo(() => ({
    loadComposes,
    switchContext,
    createCompose: (name) => withReload(() => docker.createDockerCompose(withContext(), name)),
    updateCompose: (name, content) => withReload(() => docker.updateDockerCompose(withContext(), name, content)),
    deleteCompose,
    renameCompose: (oldName, newName) => withReload(() => docker.renameDockerCompose(withContext(), oldName, newName)),
    addService: (composeName, serviceName, serviceData) => withReload(() => docker.addServiceToCompose(withContext(), composeName, serviceName, serviceData)),
    updateService: (composeName, oldName, newName, serviceData) => withReload(() => docker.updateServiceInCompose(withContext(), composeName, oldName, newName, serviceData)),
    removeService: (composeName, serviceName) => withReload(() => docker.removeServiceFromCompose(withContext(), composeName, serviceName)),
    upCompose: (name) => withReload(() => docker.upCompose(withContext(), name)),
    deployCompose: (name) => withReload(() => docker.deployCompose(withContext(), name)),
    stopCompose: (name) => withReload(() => docker.stopCompose(withContext(), name)),
    downCompose: (name) => withReload(() => docker.downCompose(withContext(), name)),
    startService: (composeName, serviceName) => withReload(() => docker.startService(withContext(), composeName, serviceName)),
    stopService: (composeName, serviceName) => withReload(() => docker.stopService(withContext(), composeName, serviceName)),
    terminateService: (composeName, serviceName) => withReload(() => docker.terminateService(withContext(), composeName, serviceName)),
    rebootService: (composeName, serviceName) => withReload(() => docker.rebootService(withContext(), composeName, serviceName)),
    deployService: (composeName, serviceName) => withReload(() => docker.deployService(withContext(), composeName, serviceName)),
  }), [loadComposes, switchContext, deleteCompose, withContext, withReload]);

  useEffect(() => {
    loadComposes();
  }, [loadComposes]);

  return (
    <DockerComposeContext.Provider value={{ ...state, actions }}>
      {children}
    </DockerComposeContext.Provider>
  );
}

export function useDockerCompose() {
  const context = useContext(DockerComposeContext);
  if (!context) {
    throw new Error('useDockerCompose must be used within a DockerComposeProvider');
  }
  return context;
}
