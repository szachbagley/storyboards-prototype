import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth.js";
import { Layout } from "./components/Layout.js";
import { ConceptDetail } from "./routes/ConceptDetail.js";
import { Concepts } from "./routes/Concepts.js";
import { FrameEditor } from "./routes/FrameEditor.js";
import { Login } from "./routes/Login.js";
import { StoryDetail } from "./routes/StoryDetail.js";
import { Stories } from "./routes/Stories.js";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root not found");

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/concepts" element={<Concepts />} />
            <Route path="/concepts/:id" element={<ConceptDetail />} />
            <Route path="/stories" element={<Stories />} />
            <Route path="/stories/:id" element={<StoryDetail />} />
            <Route path="/stories/:storyId/frames/:frameId" element={<FrameEditor />} />
          </Route>
          <Route path="*" element={<Navigate to="/concepts" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
