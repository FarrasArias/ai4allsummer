import type { ModeTab } from "./Sidebar";

type Props = {
    tab: ModeTab;
};

const STATES: Record<string, { icon: string; title: string; subtitle: string }> = {
    chat: {
        icon: "💬",
        title: "Chat",
        subtitle: "Ask anything",
    },
    vibe: {
        icon: "⟨/⟩",
        title: "Code",
        subtitle: "Describe what to build or debug",
    },
    web: {
        icon: "🌐",
        title: "Web",
        subtitle: "Search the web and ask questions",
    },
    image: {
        icon: "🖼",
        title: "Image",
        subtitle: "Analyze or generate images",
    },
    image_gen: {
        icon: "🖼",
        title: "Image Generation",
        subtitle: "Describe the image you want",
    },
    settings: {
        icon: "⚙",
        title: "Settings",
        subtitle: "Configure models and preferences",
    },
    testing: {
        icon: "🧪",
        title: "Testing",
        subtitle: "Run test suites",
    },
};

export default function EmptyState({ tab }: Props) {
    const state = STATES[tab] || STATES.chat;

    return (
        <div className="empty-state">
            <div className="empty-state-icon">{state.icon}</div>
            <div className="empty-state-title">{state.title}</div>
            <div className="empty-state-subtitle">{state.subtitle}</div>
        </div>
    );
}
