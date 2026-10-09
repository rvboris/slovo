import type { JSX } from "react";

export function PermissionDisclosure(): JSX.Element {
  return (
      <ul className="space-y-2 text-xs text-muted-foreground">
        <li className="flex gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-destructive flex-shrink-0" />
          <span>
            Доступ получает <strong className="text-foreground font-semibold">весь сеанс пользователя</strong>,
            а не только Слово. Любая программа, запущенная от вашего имени,
            сможет читать все нажатия клавиш.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-destructive flex-shrink-0" />
          <span>
            Сам помощник Слово фильтрует события локально и передаёт наружу
            только нажатия и отпускания назначенного сочетания. Но это не
            защищает от других программ того же пользователя.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-destructive flex-shrink-0" />
          <span>
            Команды ниже выполняются только вами — никаких скрытых повышений
            прав. Скопируйте их в терминал и запустите самостоятельно.
          </span>
        </li>
      </ul>
  );
}
