import { uiText, useUiLocale } from "../i18n";
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SocialPostComposer } from '@/components/SocialPostComposer'

export function NewSocialPostDialog() {
  useUiLocale();
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size="sm"
        className="h-9 gap-1.5 bg-foreground text-background hover:bg-foreground/85"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" />
        {uiText("New post")}</Button>
      <SocialPostComposer open={open} onOpenChange={setOpen} />
    </>
  )
}
