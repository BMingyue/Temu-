"""Stop only exact services belonging to this installation."""
from pathlib import Path
from workbench_processes import stop_services

if __name__ == '__main__':
    stop_services(Path(__file__).resolve().parent)
    print('This workbench installation has stopped.')
