import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // Rules of Hooks：不能按 workspacePath 条件调用 hook（同 useZCodeSessionService 的修复），
  // 否则 workspacePath 两次渲染间变化时 hook 链错位，导致 useSyncExternalStore 内部
  // 读取到其他 hook 的 memoizedState 而崩溃。
  const workspaceServices = useWorkspaceServices(
    workspacePath ?? null,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  return (workspacePath ? workspaceServices : contextServices).zcodeAgentService;
}
