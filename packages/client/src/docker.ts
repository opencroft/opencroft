/**
 * `@opencroft/client/docker` — the container snapshots the host pushes for
 * docker nodes, as React state.
 */

/** One container in a docker node's latest snapshot. */
export interface DockerContainerSnapshot {
  id: string
  name: string
  service: string
  status: string
  running: boolean
}

/**
 * The latest container snapshot for a docker node, optionally only one compose
 * service's containers. Empty until a snapshot has arrived.
 */
export declare const useDockerContainers: (
  dockerNodeId: string | null | undefined,
  service?: string,
) => DockerContainerSnapshot[]

/** Whether a snapshot has arrived for this docker node, even an empty one. */
export declare const useDockerSnapshotReceived: (dockerNodeId: string | null | undefined) => boolean

/** Seeds the store with a snapshot read some other way, such as from the node's own action. */
export declare const useSeedDockerContainers: () => (
  dockerNodeId: string,
  containers: DockerContainerSnapshot[],
) => void
