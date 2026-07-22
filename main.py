"""
Transparent Fullscreen Overlay — Pygame App Entry Point

Step 2: Initialize Pygame with a borderless, fully transparent window
spanning all connected displays. 60 FPS event loop with quit handling.
Step 5: Pet class drives mood‑based rendering (pet.py).
"""

import os
import sys
import pygame

from pet import Pet, Mood


def get_combined_display_size() -> tuple[int, int]:
    """Detect all displays and return the combined bounding-box dimensions.

    Single display → use the current mode resolution.
    Multiple displays → sum widths, take the max height (side‑by‑side merge).
    """
    pygame.display.init()  # needed before calling Info / get_desktop_sizes

    num_displays = pygame.display.get_num_displays()

    if num_displays <= 1:
        info = pygame.display.Info()
        return info.current_w, info.current_h

    # Multi‑monitor: iterate desktop sizes returned by SDL
    desktop_sizes = pygame.display.get_desktop_sizes()
    total_width = sum(size[0] for size in desktop_sizes)
    max_height = max(size[1] for size in desktop_sizes)
    return total_width, max_height


def create_transparent_window(size: tuple[int, int]) -> pygame.Surface:
    """Create a borderless, transparent, fullscreen overlay window."""
    os.environ["SDL_VIDEO_WINDOW_POS"] = "0,0"

    screen = pygame.display.set_mode(
        size,
        flags=pygame.NOFRAME | pygame.SRCALPHA,
        depth=32,
    )
    screen.fill((0, 0, 0, 0))  # fully transparent
    pygame.display.flip()
    return screen


def main() -> None:
    pygame.init()

    width, height = get_combined_display_size()
    screen = create_transparent_window((width, height))
    clock = pygame.time.Clock()

    pet = Pet(x=width - 55, y=75, radius=25)

    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                running = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_1:
                    pet.set_mood(Mood.NORMAL)
                elif event.key == pygame.K_2:
                    pet.set_mood(Mood.HAPPY)
                elif event.key == pygame.K_3:
                    pet.set_mood(Mood.BORED)
                elif event.key == pygame.K_4:
                    pet.set_mood(Mood.ANGRY)
                elif event.key == pygame.K_5:
                    pet.set_mood(Mood.SLEEPING)

        pet.update()

        screen.fill((0, 0, 0, 0))
        pet.draw(screen)
        pygame.display.flip()

        clock.tick(60)

    pygame.quit()
    sys.exit()


if __name__ == "__main__":
    main()
