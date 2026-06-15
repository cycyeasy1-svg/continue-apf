import { ConversationStarterCards } from "../../components/ConversationStarters";

// [APF] 公司 Gemini 配置已内置（见 core/config/default.ts），无需 onboarding
// 引导用户填写 API key，故直接展示对话开场卡片。
export function EmptyChatBody() {
  return (
    <div className="mx-2 mt-2">
      <ConversationStarterCards />
    </div>
  );
}
