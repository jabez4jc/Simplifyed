#!/bin/bash

################################################################################
# Simplifyed Admin - Pre-Installation Check Script
################################################################################
# This script verifies that your system meets all prerequisites before
# running the main installation script.
#
# Usage: bash pre-install-check.sh
################################################################################

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CHECKS_PASSED=0
CHECKS_FAILED=0
WARNINGS=0

print_header() {
    echo ""
    echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
    echo ""
}

check_pass() {
    echo -e "${GREEN}✓${NC} $1"
    ((CHECKS_PASSED++))
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
    ((CHECKS_FAILED++))
}

check_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
    ((WARNINGS++))
}

################################################################################
# System Checks
################################################################################

check_system() {
    print_header "System Checks"

    # Check if running as root
    if [[ $EUID -eq 0 ]]; then
        check_pass "Running with root privileges"
    else
        check_fail "Not running as root (use: sudo bash pre-install-check.sh)"
    fi

    # Check OS
    if grep -q "Ubuntu" /etc/os-release; then
        version=$(lsb_release -rs 2>/dev/null)
        if [ -n "$version" ]; then
            if (( $(echo "$version >= 20.04" | bc -l) )); then
                check_pass "Ubuntu $version detected (meets minimum requirement)"
            else
                check_warn "Ubuntu $version detected (20.04+ recommended)"
            fi
        else
            check_pass "Ubuntu detected"
        fi
    else
        check_fail "Not running Ubuntu (detected: $(grep PRETTY_NAME /etc/os-release | cut -d'"' -f2))"
    fi

    # Check architecture
    arch=$(uname -m)
    if [[ "$arch" == "x86_64" ]]; then
        check_pass "64-bit architecture ($arch)"
    else
        check_warn "Non-standard architecture detected: $arch"
    fi

    # Check memory
    total_mem=$(free -m | awk '/^Mem:/{print $2}')
    if [ "$total_mem" -ge 2048 ]; then
        check_pass "RAM: ${total_mem}MB (recommended 2GB+)"
    elif [ "$total_mem" -ge 1024 ]; then
        check_warn "RAM: ${total_mem}MB (1GB minimum, 2GB+ recommended)"
    else
        check_fail "RAM: ${total_mem}MB (insufficient, minimum 1GB required)"
    fi

    # Check disk space
    available_space=$(df -BG / | awk 'NR==2 {print $4}' | sed 's/G//')
    if [ "$available_space" -ge 10 ]; then
        check_pass "Disk space: ${available_space}GB available (10GB+ required)"
    else
        check_fail "Disk space: ${available_space}GB available (10GB+ required)"
    fi
}

################################################################################
# Network Checks
################################################################################

check_network() {
    print_header "Network Checks"

    # Check internet connectivity
    if ping -c 1 -W 2 8.8.8.8 &> /dev/null; then
        check_pass "Internet connectivity available"
    else
        check_fail "No internet connectivity"
    fi

    # Check DNS resolution
    if command -v dig &> /dev/null; then
        if dig +short google.com &> /dev/null; then
            check_pass "DNS resolution working"
        else
            check_fail "DNS resolution not working"
        fi
    elif command -v host &> /dev/null; then
        if host google.com &> /dev/null; then
            check_pass "DNS resolution working"
        else
            check_fail "DNS resolution not working"
        fi
    elif command -v nslookup &> /dev/null; then
        if nslookup google.com &> /dev/null; then
            check_pass "DNS resolution working"
        else
            check_fail "DNS resolution not working"
        fi
    else
        check_warn "No DNS tools available (dig, host, or nslookup)"
    fi

    # Check if domain is provided
    echo ""
    read -p "Enter your domain name to verify (or press Enter to skip): " domain

    if [ -n "$domain" ]; then
        echo ""
        # Check if domain resolves
        server_ip=$(curl -s ifconfig.me)

        # Try dig first, then host, then nslookup
        if command -v dig &> /dev/null; then
            domain_ip=$(dig +short "$domain" | tail -n1)
        elif command -v host &> /dev/null; then
            domain_ip=$(host "$domain" | grep "has address" | head -n1 | awk '{print $4}')
        elif command -v nslookup &> /dev/null; then
            domain_ip=$(nslookup "$domain" | grep "Address:" | tail -n1 | awk '{print $2}')
        else
            check_warn "No DNS tools available to verify domain"
            domain_ip=""
        fi

        if [ -n "$domain_ip" ]; then
            if [ "$server_ip" == "$domain_ip" ]; then
                check_pass "Domain $domain resolves to this server ($server_ip)"
            else
                check_warn "Domain $domain resolves to $domain_ip, but this server is $server_ip"
                echo "   Make sure your DNS A record points to this server's IP"
            fi
        else
            check_fail "Domain $domain does not resolve to any IP"
            echo "   Configure your DNS A record to point to: $server_ip"
        fi
    else
        check_warn "Domain verification skipped"
    fi
}

################################################################################
# Port Checks
################################################################################

check_ports() {
    print_header "Port Availability Checks"

    # Check if required ports are available
    ports_to_check=(80 443 3000)

    for port in "${ports_to_check[@]}"; do
        if netstat -tuln 2>/dev/null | grep -q ":$port " || ss -tuln 2>/dev/null | grep -q ":$port "; then
            check_warn "Port $port is already in use"
            lsof -i :$port 2>/dev/null || ss -tlnp 2>/dev/null | grep ":$port"
        else
            check_pass "Port $port is available"
        fi
    done
}

################################################################################
# Required Commands Check
################################################################################

check_commands() {
    print_header "Required Commands Check"

    required_commands=(curl wget git apt-get)

    for cmd in "${required_commands[@]}"; do
        if command -v "$cmd" &> /dev/null; then
            check_pass "Command '$cmd' is available"
        else
            check_fail "Command '$cmd' is not installed"
        fi
    done

    # Check optional but recommended commands
    optional_commands=(dig bc lsof netstat)

    for cmd in "${optional_commands[@]}"; do
        if command -v "$cmd" &> /dev/null; then
            check_pass "Optional command '$cmd' is available"
        else
            check_warn "Optional command '$cmd' is not installed (recommended)"
        fi
    done
}

################################################################################
# Existing Installation Check
################################################################################

check_existing() {
    print_header "Existing Installation Check"

    # Check if Node.js is already installed
    if command -v node &> /dev/null; then
        node_version=$(node -v)
        check_warn "Node.js is already installed ($node_version)"
        echo "   The installer will use the existing Node.js if version >= 18"
    else
        check_pass "No existing Node.js installation"
    fi

    # Check if Nginx is installed
    if command -v nginx &> /dev/null; then
        check_warn "Nginx is already installed ($(nginx -v 2>&1 | cut -d'/' -f2))"
    else
        check_pass "No existing Nginx installation"
    fi

    # Check if Simplifyed is already installed
    if [ -d "/opt/simplifyed" ]; then
        check_warn "Directory /opt/simplifyed already exists"
        echo "   The installer may overwrite existing files"
    else
        check_pass "No existing Simplifyed installation at /opt/simplifyed"
    fi

    # Check if systemd service exists
    if [ -f "/etc/systemd/system/simplifyed.service" ]; then
        check_warn "Simplifyed systemd service already exists"
    else
        check_pass "No existing Simplifyed systemd service"
    fi
}

################################################################################
# Security Checks
################################################################################

check_security() {
    print_header "Security Checks"

    # Check if firewall is installed
    if command -v ufw &> /dev/null; then
        check_pass "UFW firewall is available"

        # Check if firewall is active
        if ufw status 2>/dev/null | grep -q "Status: active"; then
            check_warn "UFW firewall is already active"
            echo "   The installer will reconfigure firewall rules"
        fi
    else
        check_pass "UFW not installed (will be installed)"
    fi

    # Check if running on default SSH port
    if netstat -tuln 2>/dev/null | grep -q ":22 " || ss -tuln 2>/dev/null | grep -q ":22 "; then
        check_warn "SSH is running on default port 22"
        echo "   Consider changing SSH port for better security"
    fi
}

################################################################################
# Summary
################################################################################

show_summary() {
    print_header "Pre-Installation Check Summary"

    echo ""
    echo -e "${GREEN}Passed:  $CHECKS_PASSED${NC}"
    echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
    echo -e "${RED}Failed:   $CHECKS_FAILED${NC}"
    echo ""

    if [ $CHECKS_FAILED -eq 0 ]; then
        echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║                                                            ║${NC}"
        echo -e "${GREEN}║  ✓ Your system is ready for installation!                 ║${NC}"
        echo -e "${GREEN}║                                                            ║${NC}"
        echo -e "${GREEN}║  Run the installer with:                                   ║${NC}"
        echo -e "${GREEN}║    sudo ./install.sh                                       ║${NC}"
        echo -e "${GREEN}║                                                            ║${NC}"
        echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"

        if [ $WARNINGS -gt 0 ]; then
            echo ""
            echo -e "${YELLOW}Note: There are $WARNINGS warning(s) above. Review them before proceeding.${NC}"
        fi
    else
        echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║                                                            ║${NC}"
        echo -e "${RED}║  ✗ System does not meet all requirements                   ║${NC}"
        echo -e "${RED}║                                                            ║${NC}"
        echo -e "${RED}║  Please fix the failed checks above before installing.     ║${NC}"
        echo -e "${RED}║                                                            ║${NC}"
        echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
    fi

    echo ""
}

################################################################################
# Main
################################################################################

main() {
    clear

    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                                                            ║${NC}"
    echo -e "${BLUE}║     Simplifyed Admin - Pre-Installation Check             ║${NC}"
    echo -e "${BLUE}║                                                            ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"

    check_system
    check_network
    check_ports
    check_commands
    check_existing
    check_security
    show_summary
}

main "$@"
