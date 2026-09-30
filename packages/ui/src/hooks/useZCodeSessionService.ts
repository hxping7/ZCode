import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // Rules of Hooks：不能按 workspacePath 条件调用 hook，否则 workspacePath
  // 在两次渲染间从 undefined 变为有值（如设置同步面板异步加载）时 hook 链会错位，
  // 触发 zustand useStore 内部 useCallback 读取到其他 hook 的 memoizedState 而崩溃。
  const workspaceServices = useWorkspaceServices(
    workspacePath ?? null,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  return (workspacePath ? workspaceServices : contextServices).zcodeSessionService;
}
