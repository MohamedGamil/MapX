# Synthetic fixture for M5-17 (mapx arch init --preset django). Not a real application.
import sys


def main():
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)


if __name__ == '__main__':
    main()
